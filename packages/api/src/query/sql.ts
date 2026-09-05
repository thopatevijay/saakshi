/**
 * DSL → parameterised SQL (D3-09).
 *
 * **This is the file the whole grounding argument rests on, so read the shape before the details.**
 *
 * Nothing a model produced is ever concatenated into a query string. The SQL text is assembled
 * entirely from *static* fragments chosen by the DSL's discriminants — an enum member selects a
 * clause, an array's length selects whether a clause appears at all — and every value the DSL
 * carries reaches Postgres as a bound parameter. There is no code path here that interpolates a
 * DSL string into SQL text, and `query-injection.test.ts` proves it the only way worth proving it:
 * by taking every fixture and every injection payload, generating the query, and asserting that no
 * value from the DSL appears anywhere in the generated text.
 *
 * That is a stronger claim than "we escape our inputs", and it is available to us for a specific
 * reason: **the model cannot name a table, a column, an operator or an ordering.** Those are not
 * fields in the DSL. The vocabulary a model has access to is a set of filters over a schema we
 * fixed in advance, so the only thing left for it to influence is *which* static clauses appear,
 * and *what values* bind into them.
 *
 * Ordering is not the model's either. D2-08 (#22) fixed it at `ts ASC, frame_pts_ms ASC,
 * sighting_id ASC` — `ts` is the PTS-derived wall clock and is THE ordering key — and this module
 * emits exactly that, always. Nothing re-sorts it downstream.
 */
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { MAX_PLATE_DISTANCE, type PlaceFilter, type QueryDSL } from '@saakshi/shared';

/**
 * The ordering every sightings query emits, from D2-08's handoff. A single constant so there is one
 * place to read it and no way for a second query to disagree.
 */
export const SIGHTING_ORDER = sql`order by s.ts asc, s.frame_pts_ms asc, s.id asc`;

export interface CompiledQuery {
  /** The drizzle fragment. Values are bound; the text is assembled from static pieces only. */
  query: SQL;
  /** The DSL that produced it, for the audit entry. */
  dsl: QueryDSL;
  /**
   * Registrations this query will resolve through D2-04's fuzzy matcher before running, when the
   * plate filter asked for `fuzzy`. Empty otherwise. The matcher is *not* reimplemented here.
   */
  needsFuzzyResolution: boolean;
}

/** Renders a fragment to `{ text, params }` — what the injection test inspects. */
export function renderQuery(query: SQL): { text: string; params: unknown[] } {
  const rendered = new PgDialect().sqlToQuery(query);
  return { text: rendered.sql, params: rendered.params };
}

/**
 * Builds the sightings query.
 *
 * `resolvedPlates` is handed in rather than computed: a fuzzy registration is resolved by D2-04's
 * `PlateSearchService` / `ConfusionPlateMatcher` (#18 — reuse, do not reimplement), whose distance
 * is fractional and weighted, and whose refusal to search a `no_letters` / `no_digits` / `empty` /
 * `too_short` read is a correctness property this module must not quietly override. By the time we
 * are here, the set of registrations is a fact, not a model's suggestion.
 */
export function buildSightingsQuery(dsl: QueryDSL, resolvedPlates: string[]): SQL {
  const where = whereClauses(dsl, resolvedPlates, 's', 'pr');
  return sql`
    select s.id::text            as sighting_id,
           s.ts                  as ts,
           s.frame_pts_ms::text  as frame_pts_ms,
           s.track_id            as track_id,
           s.camera_id::text     as camera_id,
           c.external_id         as camera_external_id,
           c.name                as camera_name,
           c.district            as district,
           case when c.location is null then null else st_y(c.location::geometry) end as lat,
           case when c.location is null then null else st_x(c.location::geometry) end as lon,
           s.class::text         as class,
           s.det_confidence::text as det_confidence,
           s.vehicle_color       as vehicle_color,
           s.is_best_shot        as is_best_shot,
           s.crop_uri            as crop_uri,
           pr.normalized_text    as plate_normalized,
           pr.raw_text           as plate_raw_text,
           pr.confidence::text   as ocr_confidence
      from sightings s
      join cameras c on c.id = s.camera_id
      left join plate_reads pr on pr.sighting_id = s.id and pr.sighting_ts = s.ts
     where ${where}
     ${SIGHTING_ORDER}
     limit ${dsl.limit}
  `;
}

/**
 * Builds the camera-rollup query — "where has this been seen", the other half of the question.
 *
 * Same `where`, so the two entities can never disagree about what was asked. Ordered by count and
 * then by the earliest sighting, which is a *presentation* order over an aggregate and therefore
 * not in tension with D2-08's rule about the sighting list.
 */
export function buildCamerasQuery(dsl: QueryDSL, resolvedPlates: string[]): SQL {
  const where = whereClauses(dsl, resolvedPlates, 's', 'pr');
  return sql`
    select c.id::text      as camera_id,
           c.external_id   as camera_external_id,
           c.name          as camera_name,
           c.district      as district,
           case when c.location is null then null else st_y(c.location::geometry) end as lat,
           case when c.location is null then null else st_x(c.location::geometry) end as lon,
           count(*)::text  as sighting_count,
           min(s.ts)       as first_seen,
           max(s.ts)       as last_seen
      from sightings s
      join cameras c on c.id = s.camera_id
      left join plate_reads pr on pr.sighting_id = s.id and pr.sighting_ts = s.ts
     where ${where}
     group by c.id, c.external_id, c.name, c.district, c.location
     order by count(*) desc, min(s.ts) asc, c.external_id asc
     limit ${dsl.limit}
  `;
}

/**
 * The sequence query: A, then later B — the question an investigator actually asks.
 *
 * A self-join on the **registration**, never on `track_id`. `track_id` is session-qualified
 * (`session_index * 100_000 + tracker_id`, D1-09 #13) and a session ends at every loop-point cut
 * and every reconnect, so joining identity across one would break in precisely the case a sequence
 * query exists for: the same vehicle, seen twice, far apart in time.
 *
 * The second leg is constrained to be strictly *later* than the first (`b.ts > a.ts`) and within
 * the stated window. Strictly later, not `>=`: two rows at the same instant are one pass through
 * one camera, and reporting that as a journey would be inventing movement.
 *
 * The result is the ordered union of both legs, so the officer sees the whole run rather than a
 * pair of endpoints — and it carries D2-08's ordering, unchanged.
 */
export function buildSequenceQuery(dsl: QueryDSL, resolvedPlates: string[]): SQL {
  const step = dsl.sequence;
  if (step === null) return buildSightingsQuery(dsl, resolvedPlates);

  const legA = whereClauses(dsl, resolvedPlates, 'a', 'pra');
  const legB = placeClause(step.place, 'cb');
  return sql`
    with leg_a as (
      select a.id as sighting_id, a.ts as ts, pra.normalized_text as plate
        from sightings a
        join cameras ca on ca.id = a.camera_id
        join plate_reads pra on pra.sighting_id = a.id and pra.sighting_ts = a.ts
       where ${legA}
         and pra.normalized_text is not null
    ),
    leg_b as (
      select b.id as sighting_id, b.ts as ts, prb.normalized_text as plate
        from sightings b
        join cameras cb on cb.id = b.camera_id
        join plate_reads prb on prb.sighting_id = b.id and prb.sighting_ts = b.ts
       where prb.normalized_text is not null
         ${legB}
    ),
    paired as (
      select leg_a.plate as plate, leg_a.sighting_id as a_id, leg_b.sighting_id as b_id
        from leg_a
        join leg_b
          on leg_b.plate = leg_a.plate
         and leg_b.ts > leg_a.ts
         and leg_b.ts <= leg_a.ts + make_interval(mins => ${step.withinMinutes})
    ),
    hits as (
      select a_id as sighting_id from paired
      union
      select b_id as sighting_id from paired
    )
    select s.id::text            as sighting_id,
           s.ts                  as ts,
           s.frame_pts_ms::text  as frame_pts_ms,
           s.track_id            as track_id,
           s.camera_id::text     as camera_id,
           c.external_id         as camera_external_id,
           c.name                as camera_name,
           c.district            as district,
           case when c.location is null then null else st_y(c.location::geometry) end as lat,
           case when c.location is null then null else st_x(c.location::geometry) end as lon,
           s.class::text         as class,
           s.det_confidence::text as det_confidence,
           s.vehicle_color       as vehicle_color,
           s.is_best_shot        as is_best_shot,
           s.crop_uri            as crop_uri,
           pr.normalized_text    as plate_normalized,
           pr.raw_text           as plate_raw_text,
           pr.confidence::text   as ocr_confidence
      from hits
      join sightings s on s.id = hits.sighting_id
      join cameras c on c.id = s.camera_id
      left join plate_reads pr on pr.sighting_id = s.id and pr.sighting_ts = s.ts
     ${SIGHTING_ORDER}
     limit ${dsl.limit}
  `;
}

/** Picks the shape. The DSL's discriminants choose a static query; nothing is assembled from text. */
export function compileQuery(dsl: QueryDSL, resolvedPlates: string[]): CompiledQuery {
  const query =
    dsl.sequence !== null
      ? buildSequenceQuery(dsl, resolvedPlates)
      : dsl.entity === 'cameras'
        ? buildCamerasQuery(dsl, resolvedPlates)
        : buildSightingsQuery(dsl, resolvedPlates);
  return {
    query,
    dsl,
    needsFuzzyResolution: dsl.filters.plate !== null && dsl.filters.plate.mode !== 'exact',
  };
}

// ── clause builders ─────────────────────────────────────────────────────────────────────────────

/**
 * Every predicate, assembled from static fragments.
 *
 * `sightingAlias` and `plateAlias` are **not** DSL-derived — they are literals chosen by the three
 * call sites above. A caller cannot pass an alias that came from a model, because no DSL field
 * carries one.
 */
function whereClauses(
  dsl: QueryDSL,
  resolvedPlates: string[],
  sightingAlias: 's' | 'a',
  plateAlias: 'pr' | 'pra',
): SQL {
  const s = sightingAlias === 's' ? sql`s` : sql`a`;
  const pr = plateAlias === 'pr' ? sql`pr` : sql`pra`;
  // A string, compared as a string. Comparing the `sql` fragments themselves is object identity and
  // is always false — which silently aliased the sightings query's camera join to `ca`.
  const cameraAlias: 'c' | 'ca' = sightingAlias === 's' ? 'c' : 'ca';
  const f = dsl.filters;
  const parts: SQL[] = [sql`true`];

  if (f.plate !== null) {
    if (resolvedPlates.length === 0) {
      // The matcher searched and found nothing, or refused to search at all (D2-04: `no_letters` /
      // `no_digits` / `empty` / `too_short` ⇒ `[]` and `searched: false`). Either way the honest
      // query is one that returns no rows — not one that silently drops the registration filter and
      // reports every vehicle in the estate.
      parts.push(sql` and false`);
    } else {
      parts.push(
        sql` and ${pr}.normalized_text in (${sql.join(
          resolvedPlates.map((plate) => sql`${plate}`),
          sql`, `,
        )})`,
      );
    }
  }

  if (f.classes.length > 0) {
    // Cast to text and compare against bound values rather than emitting enum literals: an enum
    // member is still a *value*, and keeping it bound means there is no branch in this file that
    // writes a DSL-derived token into SQL text.
    parts.push(
      sql` and ${s}.class::text in (${sql.join(
        f.classes.map((c: string) => sql`${c}`),
        sql`, `,
      )})`,
    );
  }

  if (f.colours.length > 0) {
    parts.push(
      sql` and ${s}.vehicle_color in (${sql.join(
        f.colours.map((c: string) => sql`${c}`),
        sql`, `,
      )})`,
    );
  }

  if (f.time.from !== null) parts.push(sql` and ${s}.ts >= ${f.time.from}::timestamptz`);
  if (f.time.to !== null) parts.push(sql` and ${s}.ts <= ${f.time.to}::timestamptz`);

  if (f.minConfidence > 0) {
    parts.push(sql` and ${s}.det_confidence >= ${f.minConfidence}`);
  }
  if (f.bestShotOnly) parts.push(sql` and ${s}.is_best_shot = true`);

  parts.push(placeClause(f.place, cameraAlias));

  return sql.join(parts, sql``);
}

/**
 * Where, in the three ways an officer says it.
 *
 * `nearName` is a landmark the catalogue may or may not know, matched case-insensitively against
 * the camera's name and address. It is a **bound parameter wrapped in a bound pattern** — the `%`
 * wildcards are added in JavaScript and the whole string binds as one value, so the officer's
 * landmark never becomes SQL text. A `%` or `_` typed by the officer therefore behaves as a LIKE
 * wildcard, which is the intended and documented behaviour of a search box, not an injection.
 */
function placeClause(place: PlaceFilter, alias: 'c' | 'cb' | 'ca'): SQL {
  const c = alias === 'c' ? sql`c` : alias === 'cb' ? sql`cb` : sql`ca`;
  const parts: SQL[] = [];

  if (place.cameraExternalIds.length > 0) {
    parts.push(
      sql` and ${c}.external_id in (${sql.join(
        place.cameraExternalIds.map((id: string) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
  if (place.districts.length > 0) {
    parts.push(
      sql` and ${c}.district in (${sql.join(
        place.districts.map((d: string) => sql`${d}`),
        sql`, `,
      )})`,
    );
  }
  if (place.nearName !== null) {
    const pattern = `%${place.nearName}%`;
    parts.push(sql` and (${c}.name ilike ${pattern} or coalesce(${c}.address, '') ilike ${pattern})`);
  }
  if (place.radius !== null) {
    // PostGIS `geography` gives metres directly — the reason `cameras.location` is geography rather
    // than geometry (`packages/shared/src/db/columns.ts`).
    parts.push(
      sql` and ${c}.location is not null and st_dwithin(${c}.location, st_setsrid(st_makepoint(${place.radius.lon}, ${place.radius.lat}), 4326)::geography, ${place.radius.metres})`,
    );
  }
  return parts.length === 0 ? sql`` : sql.join(parts, sql``);
}

/** Re-exported so callers cannot forget which ceiling D2-04 measured. */
export { MAX_PLATE_DISTANCE };
