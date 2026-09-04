/**
 * Catalogue sync (D1-04).
 *
 * The organisers are explicit: **`GET /api/ingest` is the contract, the URL pattern is not**, and
 * the camera set can change between now and evaluation day. So the registry has to be re-syncable
 * at any moment — including live on stage — under three rules that shape everything below:
 *
 *  1. **Never delete.** A camera that vanishes from the catalogue is still the provenance of every
 *     sighting already attached to it. It is marked absent, and flips back when it returns.
 *  2. **Never clobber a human.** `retention_days`, department assignment, `notes` and the coverage
 *     polygon are entered by people who know things the catalogue does not. More generally: a
 *     catalogue field that is absent or null never overwrites a stored value. That one rule covers
 *     every optional column, not just the four the ticket names.
 *  3. **Declared is not measured.** Everything the catalogue says about codec, fps or resolution
 *     lands in a `declared_*` column and is never treated as truth. `status` and `trust_score` are
 *     the prober's (D1-05/D1-06) and are never written here.
 *
 * Writes are diffed in memory first, so a re-sync that changes nothing performs no content writes
 * at all — which is what makes the idempotency AC provable rather than merely asserted.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { cameras, catalogueSyncRuns, departments } from '@saakshi/shared/db';
import type { AdapterKind } from '@saakshi/shared';
import type { Db, DbLike } from '../db/client.js';
import type { Principal } from '../auth.js';
import { writeAudit } from '../audit.js';
import {
  parseCatalogue,
  UnknownCatalogueShapeError,
  type CatalogueEntry,
} from './catalogue-parse.js';

export type SyncTrigger = 'cli' | 'api' | 'schedule';

export interface SyncReport {
  runId: string;
  source: string;
  departmentId: string | null;
  shape: string | null;
  trigger: SyncTrigger;
  fetched: number;
  added: number;
  updated: number;
  unchanged: number;
  wentAbsent: number;
  returned: number;
  rejected: number;
  rejections: {
    row: number;
    externalId: string | null;
    errors: { field: string; message: string }[];
  }[];
  durationMs: number;
  startedAt: string;
}

export interface SyncOptions {
  source: string;
  cookie?: string;
  /** Scope. Absence is computed inside this scope only — see `loadScope`. */
  departmentId?: string | null;
  /** Applied to **newly created** cameras only; never overwrites an operator's choice. */
  adapterKind?: AdapterKind;
  trigger: SyncTrigger;
  principal?: Principal;
  /** Injected by tests so the suite never depends on the sandbox being reachable. */
  fetchCatalogue?: (url: string, cookie: string) => Promise<unknown>;
}

/** Raised when the catalogue cannot be reached. Distinct from an unparseable one. */
export class CatalogueFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueFetchError';
  }
}

/**
 * Default fetcher.
 *
 * Both headers were established by recon (D0-01), not guessed: Cloudflare rejects a default
 * programmatic user-agent on the sandbox host, and every path 302s to the login page without the
 * session cookie. That is AC 7 — "works when the catalogue requires a session cookie" — and it is
 * why the cookie is configuration rather than a code constant.
 */
export async function defaultFetchCatalogue(url: string, cookie: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128',
      ...(cookie === '' ? {} : { cookie }),
    },
    // The sandbox gateway throttles roughly tenfold under sustained use (D1-03, BL-01): a 1.3 KB
    // catalogue measured 36 s on a bad afternoon against sub-second on a good one. The deadline is
    // sized for the bad case, because a sync that times out on stage is worse than a slow one.
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new CatalogueFetchError(`upstream returned ${String(response.status)}`);
  }
  return response.json();
}

/** The columns catalogue sync is allowed to write. Everything absent from here is local. */
interface CatalogueOwned {
  name: string;
  declaredCodec: string | null;
  declaredFps: number | null;
  declaredResolution: string | null;
  address: string | null;
  district: string | null;
  vendor: string | null;
  lat: number | null;
  lon: number | null;
  endpoints: Record<string, string>;
}

interface ExistingRow extends CatalogueOwned {
  id: string;
  externalId: string;
  catalogueStatus: 'active' | 'absent';
}

const latSql = sql<number | null>`case when ${cameras.location} is null then null
  else st_y(${cameras.location}::geometry) end`;
const lonSql = sql<number | null>`case when ${cameras.location} is null then null
  else st_x(${cameras.location}::geometry) end`;

/**
 * Every live camera in the sync's scope.
 *
 * `IS NOT DISTINCT FROM` rather than `=` because the scope is frequently NULL (no department
 * assigned yet), and `department_id = NULL` matches nothing — the same NULL trap that migration
 * 0010 had to solve with `NULLS NOT DISTINCT` on the unique constraint.
 *
 * Soft-deleted rows are excluded deliberately. A decommissioned camera reappearing upstream is a
 * human decision, not something a scheduled job should quietly reverse.
 */
async function loadScope(db: Db, departmentId: string | null): Promise<ExistingRow[]> {
  const rows = await db
    .select({
      id: cameras.id,
      externalId: cameras.externalId,
      name: cameras.name,
      declaredCodec: cameras.declaredCodec,
      declaredFps: cameras.declaredFps,
      declaredResolution: cameras.declaredResolution,
      address: cameras.address,
      district: cameras.district,
      vendor: cameras.vendor,
      lat: latSql,
      lon: lonSql,
      endpoints: cameras.endpoints,
      catalogueStatus: cameras.catalogueStatus,
    })
    .from(cameras)
    .where(
      and(
        sql`${cameras.departmentId} is not distinct from ${departmentId}`,
        isNull(cameras.deletedAt),
      ),
    );

  return rows.map((r) => ({
    ...r,
    declaredFps: r.declaredFps === null ? null : Number(r.declaredFps),
    endpoints: (r.endpoints ?? {}) as Record<string, string>,
  }));
}

/** Coordinates round-trip through PostGIS as doubles; compare at ~1 cm rather than for equality. */
const COORD_EPSILON = 1e-7;

/**
 * The catalogue-owned fields this entry actually changes.
 *
 * Rule 2 lives here: a field the catalogue did not supply is simply not in the returned object, so
 * it is never written, so it can never overwrite what a person typed. An empty result means the row
 * is unchanged and no UPDATE is issued at all.
 */
function changedFields(entry: CatalogueEntry, existing: ExistingRow): Partial<CatalogueOwned> {
  const changes: Partial<CatalogueOwned> = {};

  if (entry.name !== existing.name) changes.name = entry.name;
  if (entry.declaredCodec !== undefined && entry.declaredCodec !== existing.declaredCodec) {
    changes.declaredCodec = entry.declaredCodec;
  }
  if (entry.declaredFps !== undefined && entry.declaredFps !== existing.declaredFps) {
    changes.declaredFps = entry.declaredFps;
  }
  if (
    entry.declaredResolution !== undefined &&
    entry.declaredResolution !== existing.declaredResolution
  ) {
    changes.declaredResolution = entry.declaredResolution;
  }
  if (entry.address !== undefined && entry.address !== existing.address) {
    changes.address = entry.address;
  }
  if (entry.district !== undefined && entry.district !== existing.district) {
    changes.district = entry.district;
  }
  if (entry.vendor !== undefined && entry.vendor !== existing.vendor) changes.vendor = entry.vendor;

  if (entry.lat !== undefined && entry.lon !== undefined) {
    const moved =
      existing.lat === null ||
      existing.lon === null ||
      Math.abs(entry.lat - existing.lat) > COORD_EPSILON ||
      Math.abs(entry.lon - existing.lon) > COORD_EPSILON;
    if (moved) {
      changes.lat = entry.lat;
      changes.lon = entry.lon;
    }
  }

  // Only when the catalogue actually carried endpoints. The sandbox carries none, and writing `{}`
  // over a working URL would take the camera offline on the next sweep.
  if (Object.keys(entry.endpoints).length > 0) {
    const current = JSON.stringify(sortedEntries(existing.endpoints));
    const incoming = JSON.stringify(sortedEntries(entry.endpoints));
    if (current !== incoming) changes.endpoints = entry.endpoints;
  }

  return changes;
}

function sortedEntries(value: Record<string, string>): [string, string][] {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
}

const pointSql = (lat: number, lon: number) =>
  sql`st_setsrid(st_makepoint(${lon}, ${lat}), 4326)::geography`;

/**
 * Runs one sync.
 *
 * Everything that changes the registry happens in a single transaction together with the audit
 * entry and the run report, so a failure part-way leaves the registry exactly as it was and leaves
 * no report claiming otherwise.
 */
export async function syncCatalogue(db: Db, options: SyncOptions): Promise<SyncReport> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runId = randomUUID();
  const departmentId = options.departmentId ?? null;
  const adapterKind: AdapterKind = options.adapterKind ?? 'hls';
  const fetcher = options.fetchCatalogue ?? defaultFetchCatalogue;

  let payload: unknown;
  try {
    payload = await fetcher(options.source, options.cookie ?? '');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    // No payload arrived, so there is nothing to persist for inspection — but the failed run is
    // still recorded, because "the sync did not run" and "the sync ran and found nothing" are
    // different facts and the report has to be able to tell them apart.
    await recordFailure(db, {
      runId,
      source: options.source,
      departmentId,
      trigger: options.trigger,
      startedAt,
      startedAtMs,
      error: `catalogue fetch failed: ${message}`,
      shape: null,
      rawPayload: null,
    });
    throw err instanceof CatalogueFetchError ? err : new CatalogueFetchError(message);
  }

  let parsed;
  try {
    parsed = parseCatalogue(payload);
  } catch (err) {
    if (err instanceof UnknownCatalogueShapeError) {
      // AC 5. The raw JSON is kept so a shape change can be diagnosed from the report alone,
      // without needing to reproduce a request against an upstream that may have moved on.
      await recordFailure(db, {
        runId,
        source: options.source,
        departmentId,
        trigger: options.trigger,
        startedAt,
        startedAtMs,
        error: err.message,
        shape: null,
        rawPayload: err.payload,
      });
    }
    throw err;
  }

  const existing = await loadScope(db, departmentId);
  const byExternalId = new Map(existing.map((row) => [row.externalId, row]));
  const seen = new Set(parsed.entries.map((e) => e.externalId));

  const toInsert: CatalogueEntry[] = [];
  const toUpdate: { row: ExistingRow; changes: Partial<CatalogueOwned>; returning: boolean }[] = [];
  let unchanged = 0;
  let returned = 0;

  for (const entry of parsed.entries) {
    const row = byExternalId.get(entry.externalId);
    if (row === undefined) {
      toInsert.push(entry);
      continue;
    }
    const changes = changedFields(entry, row);
    const returning = row.catalogueStatus === 'absent';
    if (returning) returned += 1;

    if (Object.keys(changes).length > 0 || returning) {
      toUpdate.push({ row, changes, returning });
    } else {
      unchanged += 1;
    }
  }

  // Absence by set difference, inside the scope only. A camera owned by another department is not
  // missing from *this* catalogue, and marking it absent would be a lie the map would then tell.
  const wentAbsent = existing.filter(
    (row) => row.catalogueStatus === 'active' && !seen.has(row.externalId),
  );

  await db.transaction(async (tx) => {
    for (const entry of toInsert) {
      await tx.insert(cameras).values({
        externalId: entry.externalId,
        name: entry.name,
        departmentId,
        adapterKind,
        endpoints: entry.endpoints,
        declaredCodec: entry.declaredCodec ?? null,
        declaredFps: entry.declaredFps ?? null,
        declaredResolution: entry.declaredResolution ?? null,
        address: entry.address ?? null,
        district: entry.district ?? null,
        vendor: entry.vendor ?? null,
        ...(entry.lat !== undefined && entry.lon !== undefined
          ? { location: pointSql(entry.lat, entry.lon) }
          : {}),
        catalogueStatus: 'active',
        catalogueLastSeenAt: sql`now()`,
      });
    }

    for (const { row, changes, returning } of toUpdate) {
      await tx
        .update(cameras)
        .set({
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.declaredCodec !== undefined ? { declaredCodec: changes.declaredCodec } : {}),
          ...(changes.declaredFps !== undefined ? { declaredFps: changes.declaredFps } : {}),
          ...(changes.declaredResolution !== undefined
            ? { declaredResolution: changes.declaredResolution }
            : {}),
          ...(changes.address !== undefined ? { address: changes.address } : {}),
          ...(changes.district !== undefined ? { district: changes.district } : {}),
          ...(changes.vendor !== undefined ? { vendor: changes.vendor } : {}),
          ...(changes.endpoints !== undefined ? { endpoints: changes.endpoints } : {}),
          ...(typeof changes.lat === 'number' && typeof changes.lon === 'number'
            ? { location: pointSql(changes.lat, changes.lon) }
            : {}),
          ...(returning
            ? {
                catalogueStatus: 'active' as const,
                catalogueAbsentSince: null,
              }
            : {}),
          catalogueLastSeenAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(cameras.id, row.id));
    }

    // Unchanged rows get their last-seen bumped and nothing else — one statement regardless of how
    // many there are. `updated_at` is deliberately left alone: it means "the registry's picture of
    // this camera changed", and on an idempotent re-sync it did not.
    const unchangedIds = parsed.entries
      .map((e) => byExternalId.get(e.externalId))
      .filter((row): row is ExistingRow => row !== undefined)
      .filter((row) => !toUpdate.some((u) => u.row.id === row.id))
      .map((row) => row.id);

    if (unchangedIds.length > 0) {
      await tx
        .update(cameras)
        .set({ catalogueLastSeenAt: sql`now()` })
        .where(inArray(cameras.id, unchangedIds));
    }

    if (wentAbsent.length > 0) {
      await tx
        .update(cameras)
        .set({
          catalogueStatus: 'absent',
          catalogueAbsentSince: sql`now()`,
          // `updated_at` moves here: going absent genuinely is a change to what the registry knows.
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            cameras.id,
            wentAbsent.map((row) => row.id),
          ),
        );
    }

    await tx.insert(catalogueSyncRuns).values({
      id: runId,
      source: options.source,
      departmentId,
      startedAt,
      finishedAt: sql`now()`,
      durationMs: Date.now() - startedAtMs,
      ok: true,
      shape: parsed.shape,
      triggerSource: options.trigger,
      fetched: parsed.entries.length,
      added: toInsert.length,
      updated: toUpdate.length - returned,
      unchanged,
      wentAbsent: wentAbsent.length,
      returned,
      rejected: parsed.rejections.length,
      rejections: parsed.rejections,
    });

    await writeAudit(tx, options.principal, {
      action: 'camera.catalogue_sync',
      targetType: 'camera',
      purpose: `catalogue sync (${options.trigger}) from ${options.source}`,
      params: {
        runId,
        shape: parsed.shape,
        added: toInsert.length,
        updated: toUpdate.length - returned,
        unchanged,
        wentAbsent: wentAbsent.length,
        returned,
        rejected: parsed.rejections.length,
      },
      resultCount: parsed.entries.length,
    });
  });

  return {
    runId,
    source: options.source,
    departmentId,
    shape: parsed.shape,
    trigger: options.trigger,
    fetched: parsed.entries.length,
    added: toInsert.length,
    updated: toUpdate.length - returned,
    unchanged,
    wentAbsent: wentAbsent.length,
    returned,
    rejected: parsed.rejections.length,
    rejections: parsed.rejections,
    durationMs: Date.now() - startedAtMs,
    startedAt,
  };
}

interface FailureRecord {
  runId: string;
  source: string;
  departmentId: string | null;
  trigger: SyncTrigger;
  startedAt: string;
  startedAtMs: number;
  error: string;
  shape: string | null;
  rawPayload: unknown;
}

/**
 * Records a failed run.
 *
 * Outside any transaction on purpose: the point of this row is that it survives the failure. A
 * failed run written inside the aborted transaction would roll back with it, and the operator would
 * be left with an exception in a log and no persisted evidence of what the upstream actually sent.
 */
async function recordFailure(db: DbLike, failure: FailureRecord): Promise<void> {
  await db.insert(catalogueSyncRuns).values({
    id: failure.runId,
    source: failure.source,
    departmentId: failure.departmentId,
    startedAt: failure.startedAt,
    finishedAt: sql`now()`,
    durationMs: Date.now() - failure.startedAtMs,
    ok: false,
    shape: failure.shape,
    triggerSource: failure.trigger,
    error: failure.error,
    rawPayload: failure.rawPayload,
    rejections: [],
  });
}

/** Resolves a department by code or uuid, for the CLI's `--department` flag. */
export async function resolveDepartment(db: Db, ref: string): Promise<string> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  const rows = await db
    .select({ id: departments.id })
    .from(departments)
    .where(isUuid ? eq(departments.id, ref) : eq(departments.code, ref))
    .limit(1);

  const row = rows[0];
  if (row === undefined)
    throw new Error(`no department matches '${ref}' (looked up by code and id)`);
  return row.id;
}
