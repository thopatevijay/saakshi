/**
 * Valkey `evidence` stream → MinIO + the `sightings` row.
 *
 * The other half of `workers/analytics/evidence.py`. The worker holds the pixels and no
 * credentials; this consumer holds the credentials and no pixels until one arrives on the bus.
 *
 * Order of operations, and every step of it matters:
 *
 *   1. **Find the sighting row first.** The path convention is
 *      `evidence/<camera_id>/<yyyy-mm-dd>/<sighting_id>-<kind>.jpg`, so the object cannot be named
 *      until the row is known. Looking first also means a record with no row writes *nothing* —
 *      no orphan object inflating the count the gate compares against the best-shot count.
 *   2. **Then upload.** A crop with nowhere to point is not evidence.
 *   3. **Then update the row**, in that order, so a crash between 2 and 3 leaves a re-uploadable
 *      object at a deterministic key rather than a row pointing at nothing.
 *
 * Matching is `(camera_id, track_id, frame_pts_ms)`. Unique **because `track_id` is
 * session-qualified** (D1-09): the raw ByteTrack id is reused across a loop-point cut, and matching
 * on it would attach one vehicle's crop to another vehicle's row.
 *
 * A record whose sighting row has not landed yet is a real, expected case — the two streams are
 * consumed independently and the sightings consumer can be behind. It is retried a bounded number
 * of times and then counted as `unmatched`, never redelivered forever.
 */
import { sql } from 'drizzle-orm';
import { EvidenceRecord } from '@saakshi/shared';
import type { Db } from '../db/client.js';
import { CameraIdResolver, type SightingStreamReader, type StreamEntry } from './sightings.js';
import { evidenceKey, type EvidenceStore } from '../services/evidence.js';

export const EVIDENCE_STREAM = 'evidence';
export const EVIDENCE_GROUP = 'evidence-writer';
/** Crops are ~20 KB on the wire; a smaller batch than the sightings consumer's 256 on purpose. */
export const DEFAULT_BATCH_SIZE = 32;

export interface EvidenceConsumerStats {
  entriesRead: number;
  stored: number;
  bytesStored: number;
  invalidPayloads: number;
  unknownCameras: number;
  /** Records whose sighting row never arrived. Counted, never silently dropped. */
  unmatched: number;
  lowConfidenceColors: number;
  uploadFailures: number;
}

export function emptyStats(): EvidenceConsumerStats {
  return {
    entriesRead: 0,
    stored: 0,
    bytesStored: 0,
    invalidPayloads: 0,
    unknownCameras: 0,
    unmatched: 0,
    lowConfidenceColors: 0,
    uploadFailures: 0,
  };
}

interface SightingRef {
  id: string;
  ts: string;
}

/**
 * The `sightings` row a record belongs to, or `null` if it has not landed yet.
 *
 * `ts` comes back as text and is used for two things: the object's date segment, and the second
 * half of the composite primary key. It is the sighting's PTS-derived time, never the upload's —
 * a crop that lands after midnight must still retain under the day the vehicle was seen.
 */
export async function findSighting(
  db: Db,
  cameraId: string,
  trackId: number,
  framePtsMs: number,
): Promise<SightingRef | null> {
  const rows = await db.execute<{ id: string; ts: string }>(
    sql`select id::text as id, ts::text as ts
          from sightings
         where camera_id = ${cameraId}::uuid
           and track_id = ${trackId}
           and frame_pts_ms = ${framePtsMs}
         limit 1`,
  );
  return rows[0] ?? null;
}

export interface StoreEvidenceOptions {
  db: Db;
  store: EvidenceStore;
  record: EvidenceRecord;
  cameraUuid: string;
  stats: EvidenceConsumerStats;
}

/** One record: find the row, upload the crop, write the attributes back. Returns the object key. */
export async function storeEvidence(options: StoreEvidenceOptions): Promise<string | null> {
  const { db, store, record, cameraUuid, stats } = options;

  const sighting = await findSighting(db, cameraUuid, record.trackId, record.framePtsMs);
  if (sighting === null) {
    stats.unmatched += 1;
    return null;
  }

  const key = evidenceKey({
    cameraExternalId: record.cameraId,
    ts: sighting.ts,
    sightingId: sighting.id,
    kind: record.kind,
  });
  const body = Buffer.from(record.cropBase64, 'base64');
  try {
    await store.putObject(key, body, record.contentType);
  } catch {
    // An object store blip must not stall the stream or lose the row's attributes. Counted so the
    // difference between the best-shot count and the object count is always explainable.
    stats.uploadFailures += 1;
    return null;
  }

  // `crop_uri` holds `s3://<bucket>/<key>`, not a signed URL. A signed URL is a credential with an
  // expiry: persisting one would put a value in the database that stops working, and would make an
  // export bundle carry a link that is dead by the time anyone opens it. The URL is minted on read.
  const cropUri = `s3://${store.bucket}/${key}`;
  await db.execute(
    sql`update sightings
           set vehicle_color = ${record.vehicleColor},
               vehicle_color_confidence = ${record.vehicleColorConfidence},
               attributes_low_confidence = ${record.attributesLowConfidence},
               vehicle_type = ${record.vehicleType},
               crop_uri = ${cropUri},
               is_best_shot = true
         where id = ${sighting.id}::uuid
           and ts = ${sighting.ts}::timestamptz`,
  );

  stats.stored += 1;
  stats.bytesStored += body.byteLength;
  if (record.attributesLowConfidence) stats.lowConfidenceColors += 1;
  return key;
}

export interface ConsumeEvidenceOptions {
  reader: SightingStreamReader;
  db: Db;
  store: EvidenceStore;
  consumerName?: string;
  batchSize?: number;
  blockMs?: number;
  stream?: string;
  group?: string;
  maxIdlePolls?: number;
  /** Re-checks for a late sighting row before giving up. The two streams are independent. */
  matchRetries?: number;
  matchRetryDelayMs?: number;
  signal?: AbortSignal;
  onBatch?: (stored: number, stats: EvidenceConsumerStats) => void;
}

export async function consumeEvidence(
  options: ConsumeEvidenceOptions,
): Promise<EvidenceConsumerStats> {
  const {
    reader,
    db,
    store,
    consumerName = `api-${String(process.pid)}`,
    batchSize = DEFAULT_BATCH_SIZE,
    blockMs = 2_000,
    stream = EVIDENCE_STREAM,
    group = EVIDENCE_GROUP,
    maxIdlePolls = Infinity,
    matchRetries = 3,
    matchRetryDelayMs = 500,
    signal,
    onBatch,
  } = options;

  const stats = emptyStats();
  const resolver = new CameraIdResolver(db);
  await reader.ensureGroup(stream, group);

  let idlePolls = 0;
  while (signal?.aborted !== true && idlePolls < maxIdlePolls) {
    const entries: StreamEntry[] = await reader.read({
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
    let storedInBatch = 0;

    for (const entry of entries) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.payload);
      } catch {
        stats.invalidPayloads += 1;
        continue;
      }
      const result = EvidenceRecord.safeParse(parsed);
      if (!result.success) {
        stats.invalidPayloads += 1;
        continue;
      }
      const record = result.data;
      const cameraUuid = await resolver.resolve(record.cameraId);
      if (cameraUuid === null) {
        stats.unknownCameras += 1;
        continue;
      }

      // The sightings consumer may still be catching up. A bounded wait, never an unbounded one:
      // a record whose row genuinely never arrives must be counted and let go, not retried forever.
      let key: string | null = null;
      for (let attempt = 0; attempt <= matchRetries; attempt += 1) {
        const before = stats.unmatched;
        key = await storeEvidence({ db, store, record, cameraUuid, stats });
        if (key !== null || stats.unmatched === before) break;
        if (attempt < matchRetries) {
          stats.unmatched = before;
          await new Promise((resolve) => setTimeout(resolve, matchRetryDelayMs));
        }
      }
      if (key !== null) storedInBatch += 1;
    }

    // Acked after the writes, including for the records that were dropped: a payload that failed
    // validation will fail again on redelivery, and redelivering it forever is a stuck consumer.
    await reader.ack(
      stream,
      group,
      entries.map((entry) => entry.id),
    );
    onBatch?.(storedInBatch, stats);
  }

  return stats;
}
