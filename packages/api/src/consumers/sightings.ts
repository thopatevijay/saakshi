/**
 * Valkey `sightings` stream → Postgres.
 *
 * The analytics worker (`workers/analytics/`) is Python and the database is owned by this package,
 * so the bus is the seam between them. The worker publishes; this consumer is the only thing that
 * writes `sightings` rows.
 *
 * Wire contract — D2-01 extends the same payload with plate reads, so it is written down rather
 * than implied:
 *
 * ```
 * stream key   sightings
 * entry        XADD sightings MAXLEN ~ 200000 * payload <json>
 * payload      one `Sighting` (packages/shared/src/sighting.ts), camelCase, with `cameraId`
 *              carrying the camera's EXTERNAL id (`cam01`) — resolved to `cameras.id` here
 * group        sightings-writer   (created by this consumer, MKSTREAM)
 * ```
 *
 * Three properties the design turns on:
 *
 * 1. **A consumer group, not `XREAD`.** Restarting the consumer must not replay the whole stream or
 *    silently skip what arrived while it was down; the group's pending list is what makes "at least
 *    once" true across a restart.
 * 2. **Acknowledge only after the insert commits.** An entry acked before the write is an entry
 *    nobody will ever redeliver.
 * 3. **A payload that fails validation is dropped and counted, never retried forever.** A malformed
 *    entry redelivered in a loop is a stuck consumer, and the counter is what makes the drop visible
 *    instead of silent.
 */
import { sql } from 'drizzle-orm';
import { Sighting, type PlateRead } from '@saakshi/shared';
import { plateReads as plateReadsTable, sightings as sightingsTable } from '@saakshi/shared/db';
import type { Db } from '../db/client.js';

export const SIGHTINGS_STREAM = 'sightings';
export const SIGHTINGS_GROUP = 'sightings-writer';
/** Rows per INSERT. Timescale handles multi-row inserts far better than a statement per sighting. */
export const DEFAULT_BATCH_SIZE = 256;

export interface StreamEntry {
  id: string;
  payload: string;
}

/**
 * The slice of a Valkey client this consumer needs.
 *
 * Narrow on purpose: it is what lets the unit tests drive the whole decode → resolve → insert path
 * from a fake stream, without pretending a fake broker proves anything about Valkey itself. The
 * live gate run is what proves the real client.
 */
export interface SightingStreamReader {
  ensureGroup(stream: string, group: string): Promise<void>;
  read(options: {
    stream: string;
    group: string;
    consumer: string;
    count: number;
    blockMs: number;
  }): Promise<StreamEntry[]>;
  ack(stream: string, group: string, ids: string[]): Promise<void>;
  close(): Promise<void>;
}

export interface SightingsConsumerStats {
  entriesRead: number;
  inserted: number;
  /** `plate_reads` rows written (D2-01). One per vehicle track that produced a voted read. */
  plateReadsInserted: number;
  invalidPayloads: number;
  unknownCameras: number;
  /** External ids seen that are not in the registry, capped so a misconfigured worker cannot OOM us. */
  unknownCameraIds: string[];
}

export function emptyStats(): SightingsConsumerStats {
  return {
    entriesRead: 0,
    inserted: 0,
    plateReadsInserted: 0,
    invalidPayloads: 0,
    unknownCameras: 0,
    unknownCameraIds: [],
  };
}

/**
 * external id → `cameras.id`.
 *
 * Cached because the alternative is a lookup per sighting, and at the estate's sizing that is the
 * dominant query in the system. Refreshed only when an id misses, so a camera onboarded while the
 * consumer runs is picked up without a restart.
 */
export class CameraIdResolver {
  private map = new Map<string, string>();
  private loaded = false;

  constructor(private readonly db: Db) {}

  async resolve(externalId: string): Promise<string | null> {
    if (!this.loaded) await this.refresh();
    const hit = this.map.get(externalId);
    if (hit !== undefined) return hit;
    // A miss is worth one refresh — but only one, or an unknown id costs a query per sighting.
    await this.refresh();
    return this.map.get(externalId) ?? null;
  }

  async refresh(): Promise<void> {
    const rows = await this.db.execute<{ id: string; external_id: string }>(
      sql`select id::text as id, external_id from cameras where deleted_at is null`,
    );
    this.map = new Map(rows.map((row) => [row.external_id, row.id]));
    this.loaded = true;
  }
}

interface SightingRow {
  cameraId: string;
  /** ISO 8601. The `sightings.ts` column is `mode: 'string'` — Postgres parses the offset. */
  ts: string;
  framePtsMs: number;
  trackId: number;
  class: (typeof sightingsTable.$inferInsert)['class'];
  bbox: unknown;
  detConfidence: number;
}

/**
 * A decoded payload and the plate reads that travelled with it.
 *
 * They are carried side by side rather than folded into `SightingRow` because `plate_reads` is a
 * separate table that needs the `sighting_id` Postgres has not generated yet. Keeping them
 * parallel is what lets the insert stay one multi-row statement per table.
 */
interface DecodedSighting {
  row: SightingRow;
  plateReads: PlateRead[];
}

/**
 * Decodes and validates one batch, resolving external ids to uuids.
 *
 * Kept separate from the insert so the failure modes — malformed JSON, a payload that is not a
 * `Sighting`, a camera that is not in the registry — are each observable, rather than becoming one
 * indistinguishable "batch failed".
 */
export async function decodeBatch(
  entries: StreamEntry[],
  resolver: CameraIdResolver,
  stats: SightingsConsumerStats,
): Promise<DecodedSighting[]> {
  const rows: DecodedSighting[] = [];

  for (const entry of entries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.payload);
    } catch {
      stats.invalidPayloads += 1;
      continue;
    }

    const result = Sighting.safeParse(parsed);
    if (!result.success) {
      stats.invalidPayloads += 1;
      continue;
    }

    const sighting = result.data;
    const cameraId = await resolver.resolve(sighting.cameraId);
    if (cameraId === null) {
      stats.unknownCameras += 1;
      if (
        stats.unknownCameraIds.length < 20 &&
        !stats.unknownCameraIds.includes(sighting.cameraId)
      ) {
        stats.unknownCameraIds.push(sighting.cameraId);
      }
      continue;
    }

    rows.push({
      row: {
        cameraId,
        // The worker's `ts` is PTS + the stream epoch, never arrival time. Carried through, never
        // re-derived: a consumer that stamped `now()` would throw away the only timing that is the
        // camera's, and would make every row's timestamp a measure of consumer lag instead.
        ts: sighting.ts,
        framePtsMs: sighting.framePtsMs,
        trackId: sighting.trackId,
        class: sighting.class,
        bbox: sighting.bbox,
        detConfidence: sighting.detConfidence,
      },
      plateReads: sighting.plateReads,
    });
  }

  return rows;
}

export interface InsertCounts {
  sightings: number;
  plateReads: number;
}

/**
 * Writes one batch: sightings first, then the plate reads that hang off them.
 *
 * `sightings` is a hypertable, so `plate_reads` cannot carry a foreign key to it — Timescale does
 * not support being the target of a REFERENCES clause, and the composite `(id, ts)` primary key
 * could not be referenced by id alone anyway. `0005_anpr_identity.up.sql` states that referential
 * integrity is therefore the writer's responsibility. **This function is that writer**, which is
 * why the link is made from `.returning()` on the insert that generated the ids rather than from a
 * lookup afterwards: a lookup would have to guess which of several identical-looking sightings on
 * the same camera and track a read belonged to.
 *
 * `sighting_ts` is carried alongside `sighting_id` for the same reason the migration gives: without
 * it, a lookup by id alone scans every daily chunk of the hypertable.
 */
export async function insertBatch(db: Db, decoded: DecodedSighting[]): Promise<InsertCounts> {
  if (decoded.length === 0) return { sightings: 0, plateReads: 0 };

  const inserted = await db
    .insert(sightingsTable)
    .values(decoded.map((item) => item.row))
    .returning({ id: sightingsTable.id, ts: sightingsTable.ts });

  const reads: (typeof plateReadsTable.$inferInsert)[] = [];
  for (const [index, item] of decoded.entries()) {
    const parent = inserted[index];
    if (parent === undefined) continue;
    for (const read of item.plateReads) {
      reads.push({
        sightingId: parent.id,
        sightingTs: parent.ts,
        rawText: read.rawText,
        // Left as the worker sent it — `null`. D2-03 owns normalisation and grammar validation,
        // and the rejection rate per camera is a trust signal that only exists if this column
        // distinguishes "not normalised yet" from "normalised to nothing".
        normalizedText: read.normalizedText,
        confidence: read.confidence,
        isBestShot: read.isBestShot,
        voteCount: read.voteCount,
        cropUri: read.cropUri,
      });
    }
  }
  if (reads.length > 0) await db.insert(plateReadsTable).values(reads);

  return { sightings: inserted.length, plateReads: reads.length };
}

export interface ConsumeOptions {
  reader: SightingStreamReader;
  db: Db;
  consumerName?: string;
  batchSize?: number;
  blockMs?: number;
  stream?: string;
  group?: string;
  /** Stop after this many polls that returned nothing. `Infinity` for a long-running service. */
  maxIdlePolls?: number;
  signal?: AbortSignal;
  onBatch?: (inserted: number, stats: SightingsConsumerStats) => void;
}

/**
 * Drains the stream until aborted or idle.
 *
 * The insert and the ack are ordered, not transactional across the two systems: a crash between
 * them redelivers the batch, which the composite `(id, ts)` primary key makes harmless — the worker
 * generates no id, so a redelivered batch inserts fresh rows rather than colliding. Duplicate
 * sightings are a known, bounded cost of at-least-once and are recorded as such rather than being
 * papered over with an idempotency key nobody could compute from a bbox.
 */
export async function consumeSightings(options: ConsumeOptions): Promise<SightingsConsumerStats> {
  const {
    reader,
    db,
    consumerName = `api-${String(process.pid)}`,
    batchSize = DEFAULT_BATCH_SIZE,
    blockMs = 2_000,
    stream = SIGHTINGS_STREAM,
    group = SIGHTINGS_GROUP,
    maxIdlePolls = Infinity,
    signal,
    onBatch,
  } = options;

  const stats = emptyStats();
  const resolver = new CameraIdResolver(db);
  await reader.ensureGroup(stream, group);

  let idlePolls = 0;
  while (signal?.aborted !== true && idlePolls < maxIdlePolls) {
    const entries = await reader.read({
      stream,
      group,
      consumer: consumerName,
      count: batchSize,
      blockMs,
    });

    if (entries.length === 0) {
      idlePolls += 1;
      continue;
    }
    idlePolls = 0;
    stats.entriesRead += entries.length;

    const rows = await decodeBatch(entries, resolver, stats);
    const counts = await insertBatch(db, rows);
    stats.inserted += counts.sightings;
    stats.plateReadsInserted += counts.plateReads;

    // Acked after the insert commits, including for the entries that were dropped: a payload that
    // failed validation will fail again on redelivery, and redelivering it forever is a stuck
    // consumer. The counters are what make the drop visible.
    await reader.ack(
      stream,
      group,
      entries.map((entry) => entry.id),
    );
    onBatch?.(rows.length, stats);
  }

  return stats;
}
