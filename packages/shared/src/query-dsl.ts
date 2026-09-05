/**
 * The query DSL (D3-09) — the only thing a language model is ever allowed to produce.
 *
 * **The grounding rules are the whole design.** A model asked an investigative question does not
 * answer it and does not see a row; it writes a *filter*, in this vocabulary, and nothing else.
 * Everything below exists to make that constraint structural rather than aspirational:
 *
 * 1. **Closed.** Every object is `.strict()`, so an unknown key is a rejection rather than a field
 *    that quietly rides along into the compiler.
 * 2. **Enumerated.** Colour, vehicle class, entity and link method are `z.enum` over the real
 *    database enums. A model cannot invent `class: 'tempo'`; it can only choose from what the
 *    schema already holds.
 * 3. **Nullable, never optional.** Every property is present on every instance. That is partly
 *    OpenAI's Structured Outputs requirement — `strict: true` demands every property appear in
 *    `required` — and partly a readability property: an officer reading the compiled filter sees
 *    the whole shape, with `null` where the model chose not to constrain, rather than having to
 *    infer meaning from an absent key.
 * 4. **Bounded.** `maxDistance` is hard-capped at **2**. D2-04 (#18) measured the knee: `d ≤ 2` is
 *    99.9% recall at 100% precision, 3.0 drops precision to 91.2% and 4.0 to 54.8%, where
 *    unrelated registrations start matching. A model that asks for 4 is asking to accuse the wrong
 *    vehicle, so the *type* refuses rather than the reviewer having to notice.
 *
 * **What is deliberately absent is as load-bearing as what is present.**
 *
 * - There is **no `purpose` field**, and there never will be. D3-04 (#27) binds every search to a
 *   stated reason recorded against the officer's badge. A model that could emit a purpose could
 *   manufacture the justification for the search it is itself proposing, which would turn the audit
 *   chain into a record of the model's imagination. The officer states the purpose, out of band,
 *   and `query-dsl.test.ts` asserts the field cannot appear.
 * - There is **no free-form SQL, table name, column name, ordering or limit expression.** Sorting
 *   is fixed by D2-08 (#22) at `ts ASC, framePtsMs ASC, sightingId ASC` and is not the model's to
 *   choose.
 * - There is **no `trackId` linking clause.** `track_id` is session-qualified
 *   (`session_index * 100_000 + tracker_id`, D1-09 #13) and a session ends at every loop-point cut
 *   and every reconnect, so an identity claim joined on it would silently break across a scene cut.
 */
import { z } from 'zod';

/** Pinned in the payload so a stored or replayed DSL can be recognised when this shape moves on. */
export const QUERY_DSL_VERSION = 1;

/**
 * Mirrors `vehicle_class` in `db/migrations/0002_enums.up.sql`. `person` is included because the
 * detector emits it; no biometric processing follows from that, and none is in scope (CLAUDE.md).
 */
export const QueryVehicleClass = z.enum([
  'car',
  'motorcycle',
  'bus',
  'truck',
  'auto_rickshaw',
  'bicycle',
  'person',
  'unknown',
]);
export type QueryVehicleClass = z.infer<typeof QueryVehicleClass>;

/**
 * The colour vocabulary the attribute classifier actually writes to `sightings.vehicle_color`.
 *
 * `unknown` is a real value rather than a gap: D2-02 records `unknown` with
 * `attributes_low_confidence` set instead of quietly promoting the runner-up, and a query for
 * "white cars" must not silently sweep in the ones we could not colour.
 */
export const QueryVehicleColour = z.enum([
  'white',
  'black',
  'silver',
  'grey',
  'red',
  'blue',
  'green',
  'yellow',
  'orange',
  'brown',
  'unknown',
]);
export type QueryVehicleColour = z.infer<typeof QueryVehicleColour>;

/**
 * How a registration is matched.
 *
 * `fuzzy` runs D2-04's confusion-weighted matcher, whose distance is **fractional and weighted, not
 * levenshtein**. `prefix` exists because truncation — not substitution — is this estate's dominant
 * OCR failure (D2-01: `GJ35U0779 → GJ35U07`), and charging a missing tail as substitutions loses
 * the match a prefix search finds immediately.
 */
export const PlateMatchMode = z.enum(['exact', 'fuzzy', 'prefix']);
export type PlateMatchMode = z.infer<typeof PlateMatchMode>;

/**
 * D2-04's measured ceiling, enforced by the type.
 *
 * Not a lint, not a code review note, not a runtime warning — a value above this does not parse, so
 * no provider, no hand-edit and no replayed transcript can get past it.
 */
export const MAX_PLATE_DISTANCE = 2;

/**
 * A registration, or the fragment of one an officer remembers.
 *
 * The character class is the tightest one that still admits every real query: upper-case letters,
 * digits, and the two wildcards a half-remembered plate needs. It admits no quote, no semicolon, no
 * whitespace and no comment marker — which is a defence in depth rather than the defence, since the
 * pattern never reaches SQL as text in the first place.
 */
export const PlatePattern = z
  .string()
  .trim()
  .min(1)
  .max(12)
  .regex(/^[A-Z0-9?*]+$/, 'a plate pattern may contain A–Z, 0–9 and the wildcards ? and * only');

export const PlateFilter = z
  .object({
    pattern: PlatePattern,
    mode: PlateMatchMode,
    /** Fractional and weighted (D2-04). Capped at 2 — see `MAX_PLATE_DISTANCE`. */
    maxDistance: z.number().min(0).max(MAX_PLATE_DISTANCE),
  })
  .strict();
export type PlateFilter = z.infer<typeof PlateFilter>;

/**
 * A place, expressed the three ways an officer expresses one.
 *
 * `cameraExternalIds` are catalogue ids (`cam05`), never database uuids — an officer says "cam five",
 * and a model that had to emit a uuid would hallucinate one. Resolution to uuids happens in the
 * compiler, against the real catalogue, where a name that does not exist becomes an honest
 * "no such camera" rather than a filter that silently matches nothing.
 */
export const PlaceFilter = z
  .object({
    cameraExternalIds: z.array(z.string().trim().min(1).max(64)).max(50),
    districts: z.array(z.string().trim().min(1).max(64)).max(20),
    /** Free-text fragment matched against camera name and address — a landmark, e.g. "Adalaj". */
    nearName: z.string().trim().min(1).max(80).nullable(),
    /** A true geographic radius, in metres, resolved by PostGIS against `cameras.location`. */
    radius: z
      .object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        metres: z.number().int().min(10).max(50_000),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PlaceFilter = z.infer<typeof PlaceFilter>;

export const TimeWindow = z
  .object({
    from: z.iso.datetime().nullable(),
    to: z.iso.datetime().nullable(),
  })
  .strict();
export type TimeWindow = z.infer<typeof TimeWindow>;

/**
 * "…and later appeared near Adalaj" — the second leg of the question investigators actually ask.
 *
 * A sequence is two observations of the *same registration*, ordered in time, with a ceiling on the
 * gap between them. It is emphatically **not** a `track_id` join: `track_id` does not survive a
 * scene cut or a reconnect (D1-09 #13), so linking identity across one would be wrong in exactly
 * the situation — a vehicle seen twice, far apart — that a sequence query is for.
 */
export const SequenceStep = z
  .object({
    place: PlaceFilter,
    /** Ceiling on the gap between the first leg and this one. Bounded to keep the self-join sane. */
    withinMinutes: z.number().int().min(1).max(1440),
  })
  .strict();
export type SequenceStep = z.infer<typeof SequenceStep>;

export const QueryFilters = z
  .object({
    plate: PlateFilter.nullable(),
    classes: z.array(QueryVehicleClass).max(8),
    colours: z.array(QueryVehicleColour).max(11),
    place: PlaceFilter,
    time: TimeWindow,
    /** Floor on detection/OCR confidence, `[0,1]`. 0 keeps everything the pipeline recorded. */
    minConfidence: z.number().min(0).max(1),
    /** Only sightings the pipeline chose as the best frame of a track session. */
    bestShotOnly: z.boolean(),
  })
  .strict();
export type QueryFilters = z.infer<typeof QueryFilters>;

/**
 * What the officer gets back.
 *
 * `sightings` is the row-level answer; `cameras` aggregates the same filter by camera, which is the
 * shape of "where has this been seen". Both reuse D2-08's ordering and its views.
 */
export const QueryEntity = z.enum(['sightings', 'cameras']);
export type QueryEntity = z.infer<typeof QueryEntity>;

/** Hard ceiling on rows. A console is not a bulk export; an export goes through D3-04's bundle. */
export const MAX_QUERY_LIMIT = 500;

export const QueryDSL = z
  .object({
    version: z.literal(QUERY_DSL_VERSION),
    entity: QueryEntity,
    filters: QueryFilters,
    /** The "…then later near X" leg, or `null` for a single-leg question. */
    sequence: SequenceStep.nullable(),
    limit: z.number().int().min(1).max(MAX_QUERY_LIMIT),
  })
  .strict();
export type QueryDSL = z.infer<typeof QueryDSL>;

/**
 * The filter that constrains nothing — what an unparseable question degrades to, and the base an
 * officer edits from in the console.
 */
export const EMPTY_PLACE: PlaceFilter = {
  cameraExternalIds: [],
  districts: [],
  nearName: null,
  radius: null,
};

export const EMPTY_QUERY_DSL: QueryDSL = {
  version: QUERY_DSL_VERSION,
  entity: 'sightings',
  filters: {
    plate: null,
    classes: [],
    colours: [],
    place: EMPTY_PLACE,
    time: { from: null, to: null },
    minConfidence: 0,
    bestShotOnly: false,
  },
  sequence: null,
  limit: 100,
};

/**
 * A DSL that would return the entire estate.
 *
 * Not an error — "show me everything at cam05 tonight" is a legitimate question — but the console
 * says so out loud, because a filter that constrains nothing is far more often a compile that went
 * wrong than a question that was actually asked.
 */
export function isUnconstrained(dsl: QueryDSL): boolean {
  const f = dsl.filters;
  return (
    f.plate === null &&
    f.classes.length === 0 &&
    f.colours.length === 0 &&
    f.place.cameraExternalIds.length === 0 &&
    f.place.districts.length === 0 &&
    f.place.nearName === null &&
    f.place.radius === null &&
    f.time.from === null &&
    f.time.to === null &&
    f.minConfidence === 0 &&
    !f.bestShotOnly &&
    dsl.sequence === null
  );
}

/**
 * A one-line-per-constraint rendering of the filter, for the console's editable chips, the audit
 * entry and the demo output.
 *
 * The officer approving a filter has to be able to read it. A JSON blob is not a review; a list of
 * short English clauses is.
 */
export function describeQueryDsl(dsl: QueryDSL): string[] {
  const out: string[] = [];
  const f = dsl.filters;
  if (f.plate !== null) {
    const how =
      f.plate.mode === 'exact'
        ? 'exactly'
        : f.plate.mode === 'prefix'
          ? 'starting with'
          : `within a weighted distance of ${f.plate.maxDistance}`;
    out.push(`registration ${how} ${f.plate.pattern}`);
  }
  if (f.classes.length > 0) out.push(`class is ${f.classes.join(' or ')}`);
  if (f.colours.length > 0) out.push(`colour is ${f.colours.join(' or ')}`);
  out.push(...describePlace(f.place));
  if (f.time.from !== null && f.time.to !== null) {
    out.push(`between ${f.time.from} and ${f.time.to}`);
  } else if (f.time.from !== null) {
    out.push(`after ${f.time.from}`);
  } else if (f.time.to !== null) {
    out.push(`before ${f.time.to}`);
  }
  if (f.minConfidence > 0) out.push(`confidence at least ${f.minConfidence}`);
  if (f.bestShotOnly) out.push('best frame of each track only');
  if (dsl.sequence !== null) {
    const where = describePlace(dsl.sequence.place);
    const tail = where.length === 0 ? 'anywhere' : where.join(' and ');
    out.push(`then seen ${tail} within ${dsl.sequence.withinMinutes} minutes`);
  }
  out.push(`return up to ${dsl.limit} ${dsl.entity}`);
  return out;
}

function describePlace(place: PlaceFilter): string[] {
  const out: string[] = [];
  if (place.cameraExternalIds.length > 0) out.push(`at camera ${place.cameraExternalIds.join(', ')}`);
  if (place.districts.length > 0) out.push(`in district ${place.districts.join(', ')}`);
  if (place.nearName !== null) out.push(`near "${place.nearName}"`);
  if (place.radius !== null) {
    out.push(`within ${place.radius.metres} m of ${place.radius.lat}, ${place.radius.lon}`);
  }
  return out;
}

// ── JSON Schema derivation ──────────────────────────────────────────────────────────────────────

/**
 * The one JSON-Schema keyword set the providers agree on.
 *
 * OpenAI's Structured Outputs, Anthropic's `strict: true` tool schemas and ollama's `format` are
 * three implementations of "constrain decoding to this schema", and they intersect at a small
 * subset. Anything outside this list is a keyword one of them will ignore — and a constraint that
 * is silently ignored is worse than one that was never written, because it reads as protection.
 */
const ALLOWED_SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'description',
  '$defs',
  '$ref',
  '$schema',
  'title',
]);

/**
 * Keywords zod emits that at least one of the three providers does not honour at decode time.
 *
 * They are not dropped — they are **demoted into the `description`**, so the model still reads
 * "1–12 characters, matching ^[A-Z0-9?*]+$" in prose while the schema stays inside the portable
 * subset. The real enforcement was never here: `QueryDSL.safeParse` runs on everything a provider
 * returns, and *that* is the boundary. What this avoids is a schema that looks like it constrains
 * `maxDistance ≤ 2` on one provider and quietly does not on another.
 */
const DEMOTED_KEYWORDS: Record<string, (value: unknown) => string> = {
  minLength: (v) => `at least ${String(v)} characters`,
  maxLength: (v) => `at most ${String(v)} characters`,
  pattern: (v) => `matching the regular expression ${String(v)}`,
  format: (v) => `in ${String(v)} format`,
  minimum: (v) => `at least ${String(v)}`,
  maximum: (v) => `at most ${String(v)}`,
  exclusiveMinimum: (v) => `greater than ${String(v)}`,
  exclusiveMaximum: (v) => `less than ${String(v)}`,
  minItems: (v) => `at least ${String(v)} entries`,
  maxItems: (v) => `at most ${String(v)} entries`,
  multipleOf: (v) => `a multiple of ${String(v)}`,
};

export class StrictSchemaError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path === '' ? '<root>' : path})`);
    this.name = 'StrictSchemaError';
  }
}

type JsonSchemaNode = Record<string, unknown>;

/**
 * Walks a derived schema and *proves* it satisfies the strict subset, rather than assuming zod
 * emitted something acceptable.
 *
 * Three properties, each of which a provider silently degrades if it is missing:
 * `additionalProperties: false` on every object (or the model may add keys), every declared
 * property present in `required` (OpenAI rejects a strict schema with optional properties), and no
 * keyword outside the agreed set (a numeric `minimum`, for instance, constrains nothing at decode
 * time — which is exactly why `maxDistance`'s real ceiling is enforced by zod on the way back in,
 * not by the schema on the way out).
 */
export function assertStrictSubset(schema: JsonSchemaNode, path = ''): void {
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYWORDS.has(key)) {
      throw new StrictSchemaError(`unsupported JSON Schema keyword \`${key}\``, path);
    }
  }
  const defs = schema['$defs'];
  if (defs !== undefined && typeof defs === 'object' && defs !== null) {
    for (const [name, node] of Object.entries(defs as Record<string, unknown>)) {
      assertStrictSubset(node as JsonSchemaNode, `${path}/$defs/${name}`);
    }
  }
  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    anyOf.forEach((node, i) => assertStrictSubset(node as JsonSchemaNode, `${path}/anyOf/${i}`));
  }
  const items = schema['items'];
  if (items !== undefined && typeof items === 'object' && items !== null) {
    assertStrictSubset(items as JsonSchemaNode, `${path}/items`);
  }
  if (schema['type'] !== 'object') return;

  const properties = schema['properties'];
  if (properties === undefined) return;
  if (schema['additionalProperties'] !== false) {
    throw new StrictSchemaError('object without `additionalProperties: false`', path);
  }
  const names = Object.keys(properties as Record<string, unknown>);
  const required = schema['required'];
  const requiredList = Array.isArray(required) ? (required as string[]) : [];
  for (const name of names) {
    if (!requiredList.includes(name)) {
      throw new StrictSchemaError(`property \`${name}\` is not in \`required\``, path);
    }
    assertStrictSubset(
      (properties as Record<string, JsonSchemaNode>)[name] as JsonSchemaNode,
      `${path}/${name}`,
    );
  }
}

/**
 * The schema every provider is handed — **derived from `QueryDSL`, never written twice.**
 *
 * The single-source-of-truth property is the point: a field added to the zod schema without being
 * added here would be a field the compiler accepts but the model was never told about, and a field
 * removed here but not there would be one the model keeps emitting into a rejection. Deriving it
 * makes both impossible, and `assertStrictSubset` runs on every call so a schema that would be
 * silently degraded by a provider fails loudly here instead.
 */
export function queryDslJsonSchema(): JsonSchemaNode {
  const schema = z.toJSONSchema(QueryDSL, {
    target: 'draft-2020-12',
    io: 'input',
    // Inline everything. `$ref` into `$defs` is accepted by OpenAI but not uniformly by ollama's
    // grammar compiler, and a schema that constrains decoding on two providers out of three is a
    // vendor-neutrality claim that does not survive contact with the third.
    reused: 'inline',
  }) as JsonSchemaNode;
  const portable = toPortableSchema(schema);
  assertStrictSubset(portable);
  return portable;
}

/**
 * Rewrites a zod-derived schema into the portable subset, demoting the constraint keywords the
 * providers disagree on into `description` prose rather than leaving them to be ignored.
 *
 * Pure: the input is not mutated, so a caller can compare before and after — and
 * `query-dsl.test.ts` does exactly that, to prove the demotion loses no constraint silently.
 */
export function toPortableSchema(node: JsonSchemaNode): JsonSchemaNode {
  const out: JsonSchemaNode = {};
  const hints: string[] = [];

  for (const [key, value] of Object.entries(node)) {
    const demote = DEMOTED_KEYWORDS[key];
    if (demote !== undefined) {
      hints.push(demote(value));
      continue;
    }
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const properties: JsonSchemaNode = {};
      for (const [name, child] of Object.entries(value as Record<string, JsonSchemaNode>)) {
        properties[name] = toPortableSchema(child);
      }
      out['properties'] = properties;
      continue;
    }
    if (key === '$defs' && typeof value === 'object' && value !== null) {
      const defs: JsonSchemaNode = {};
      for (const [name, child] of Object.entries(value as Record<string, JsonSchemaNode>)) {
        defs[name] = toPortableSchema(child);
      }
      out['$defs'] = defs;
      continue;
    }
    if (key === 'anyOf' && Array.isArray(value)) {
      out['anyOf'] = value.map((child) => toPortableSchema(child as JsonSchemaNode));
      continue;
    }
    if (key === 'items' && typeof value === 'object' && value !== null) {
      out['items'] = toPortableSchema(value as JsonSchemaNode);
      continue;
    }
    if (!ALLOWED_SCHEMA_KEYWORDS.has(key)) {
      // Unknown *and* not on the demotion list: dropping it silently is the failure mode this
      // whole module exists to avoid, so it is a hard error and someone has to decide.
      throw new StrictSchemaError(`unsupported JSON Schema keyword \`${key}\``, '');
    }
    out[key] = value;
  }

  if (hints.length > 0) {
    const existing = typeof out['description'] === 'string' ? `${out['description']} ` : '';
    out['description'] = `${existing}Must be ${hints.join(', ')}.`;
  }
  return out;
}
