/**
 * The alert queue, populated from the estate's own measured plate reads (D2-07).
 *
 * **What is measured and what is not, stated first.** The 17 strings below are the real output of
 * D2-01's 5-minute 8-camera live run against the sandbox gateway, with the confidences D2-01
 * recorded — `docs/anpr-accuracy.md` §8 lists them and `docs/alerting.md` §7 predicts exactly what
 * D2-06's engine does with each one. Nothing here is an invented registration and no number is
 * adjusted. What this seeder does *not* reproduce is the original read→sighting pairing: this
 * database's `plate_reads` table is empty, because D2-01's run wrote its reads to its own database.
 * So each read is attached to a **real sighting row from the same estate**, chosen deterministically
 * (n-th sighting on that camera, ordered by PTS-derived `ts`), on the camera the measurement names
 * where the measurement names one and round-robin over the seven cameras that actually have
 * sightings where it does not. The camera, the timestamp, the track id and the vehicle class on
 * every resulting alert are therefore real; the association of a read with that particular vehicle
 * is a fixture, and no claim rests on it.
 *
 * **What it must produce**, and asserts before exiting: **7 alerts — 5 `low` exact, 2 `medium`
 * fuzzy, 0 `high`, 0 `critical`** — and `757508300`, the highest-confidence read of the entire run,
 * raising **nothing**. That distribution is the finding, not a shortfall: five of the seven are
 * exact string matches against watchlist rows whose own note says *"SELECTED FROM MEASURED ANPR
 * OUTPUT, NOT FROM A VEHICLE REGISTRY"*, and the alert queue carries that note rather than dressing
 * them up as vehicle records.
 *
 *   npm run demo:alerts -w packages/api -- --seed
 *   npm run demo:alerts -w packages/api -- --remove
 */
import { sql } from 'drizzle-orm';
import { createDb, createSql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { AlertEngine } from '../services/alerts.js';
import { ConfusionPlateMatcher } from '../services/plate-search.js';
import {
  createWatchlistRegistry,
  loadSeedCsv,
  SEED_CSV_PATH,
  upsertWatchlistEntries,
} from '../watchlist/index.js';

/** One measured read. `camera` is `null` where the measurement does not name one. */
interface MeasuredRead {
  rawText: string;
  confidence: number;
  camera: string | null;
  /** Which sighting on that camera to attach it to. Deterministic, so `--remove` is exact. */
  offset: number;
}

/**
 * D2-01's live run, verbatim: the 15 strings the ANPR emitted plus the two ground-truth
 * registrations that genuinely appear on `cam07` at night (`docs/anpr-accuracy.md` §6 rows
 * `night_cam07_102_02` and `night_cam07_111_02`, truncated by the reader to `GJ35U07` and
 * `GJ32DD10`).
 */
const MEASURED_READS: readonly MeasuredRead[] = [
  { rawText: '757508300', confidence: 0.888, camera: 'cam05', offset: 0 },
  { rawText: '44671', confidence: 0.732, camera: 'cam08', offset: 1 },
  { rawText: 'P41', confidence: 0.687, camera: null, offset: 2 },
  { rawText: '1118R', confidence: 0.627, camera: null, offset: 3 },
  { rawText: '41111', confidence: 0.584, camera: null, offset: 4 },
  { rawText: '755508000', confidence: 0.575, camera: null, offset: 5 },
  { rawText: '46101', confidence: 0.56, camera: null, offset: 6 },
  { rawText: '46111', confidence: 0.514, camera: null, offset: 7 },
  { rawText: 'AAM412', confidence: 0.503, camera: null, offset: 8 },
  { rawText: 'GJ3266416', confidence: 0.449, camera: 'cam07', offset: 9 },
  { rawText: '15144', confidence: 0.429, camera: null, offset: 10 },
  { rawText: '41111', confidence: 0.36, camera: null, offset: 11 },
  { rawText: '71TT', confidence: 0.355, camera: null, offset: 12 },
  { rawText: '7', confidence: 0.336, camera: null, offset: 13 },
  { rawText: 'A1110', confidence: 0.323, camera: null, offset: 14 },
  { rawText: 'GJ35U07', confidence: 0.6, camera: 'cam07', offset: 15 },
  { rawText: 'GJ32DD10', confidence: 0.6, camera: 'cam07', offset: 16 },
];

interface Chosen {
  read: MeasuredRead;
  sightingId: string;
  sightingTs: string;
  cameraId: string;
  cameraExternalId: string;
}

const env = loadEnv({ ...process.env, NODE_ENV: process.env['NODE_ENV'] ?? 'development' });
const rawSql = createSql(env.DATABASE_URL, 4);
const db = createDb(rawSql);

function out(message: string): void {
  console.log(`  ${message}`);
}

/**
 * Pick one real sighting per read.
 *
 * `order by ts, id` rather than `order by ts` alone: two detections in the same frame share a
 * timestamp, and an unstable order would make `--remove` delete a different row than `--seed`
 * created an alert from.
 */
async function chooseSightings(): Promise<Chosen[]> {
  const cams = await db.execute<{ id: string; external_id: string }>(sql`
    select c.id::text as id, c.external_id
      from cameras c
     where c.deleted_at is null
       and exists (select 1 from sightings s where s.camera_id = c.id)
     order by c.external_id
  `);
  if (cams.length === 0) {
    throw new Error(
      'no camera in this database has any sighting — nothing real to attach a read to',
    );
  }

  const chosen: Chosen[] = [];
  for (const [index, read] of MEASURED_READS.entries()) {
    const camera =
      (read.camera === null ? undefined : cams.find((c) => c.external_id === read.camera)) ??
      cams[index % cams.length];
    if (camera === undefined) throw new Error('camera selection produced nothing');

    // `to_char(... 'US')` rather than `new Date(row.ts).toISOString()`: `sightings.ts` is
    // `timestamptz` at **microsecond** precision and `AlertEngine.correlate` matches the sighting on
    // `s.ts = $sightingTs` exactly. A JS `Date` truncates to milliseconds, so a round trip through
    // one loses `…49.208942Z` → `…49.208Z`, the predicate misses, and the engine returns
    // `skipped: 'unknown_sighting'` for a sighting that plainly exists. Logged to BL-01.
    const rows = await db.execute<{ id: string; ts: string }>(sql`
      select id::text as id,
             to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts
        from sightings
       where camera_id = ${camera.id}::uuid
       order by ts, id
       offset ${read.offset} limit 1
    `);
    const sighting = rows[0];
    if (sighting === undefined) {
      throw new Error(
        `camera ${camera.external_id} has no sighting at offset ${String(read.offset)}`,
      );
    }
    chosen.push({
      read,
      sightingId: sighting.id,
      sightingTs: sighting.ts,
      cameraId: camera.id,
      cameraExternalId: camera.external_id,
    });
  }
  return chosen;
}

async function seed(): Promise<void> {
  const batch = await loadSeedCsv(SEED_CSV_PATH);
  await upsertWatchlistEntries(db, batch.valid);

  const engine = new AlertEngine({
    db,
    registry: createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) }),
  });
  const chosen = await chooseSightings();

  out(`policy v${String(engine.policy.version)} · ${String(chosen.length)} measured reads`);

  const raised: { read: string; severity: string; matchType: string; distance: number }[] = [];
  for (const item of chosen) {
    const outcome = await engine.correlate({
      sightingId: item.sightingId,
      sightingTs: item.sightingTs,
      cameraId: item.cameraId,
      rawText: item.read.rawText,
      confidence: item.read.confidence,
    });
    for (const alert of outcome.alerts) {
      raised.push({
        read: item.read.rawText,
        severity: alert.severity,
        matchType: alert.matchType,
        distance: alert.matchDistance,
      });
    }
    const verdict =
      outcome.alerts.length === 0 ? `no alert (${outcome.skipped ?? 'no hit'})` : 'ALERT';
    out(
      `${item.read.rawText.padEnd(10)} ${item.read.confidence.toFixed(3)}  ` +
        `${item.cameraExternalId}  ${verdict}`,
    );
  }

  const counts = raised.reduce<Record<string, number>>((acc, r) => {
    acc[r.severity] = (acc[r.severity] ?? 0) + 1;
    return acc;
  }, {});
  const exact = raised.filter((r) => r.matchType === 'exact').length;
  const fuzzy = raised.filter((r) => r.matchType === 'fuzzy').length;

  console.log('');
  out(
    `${String(raised.length)} alerts — ` +
      `${String(counts['low'] ?? 0)} low · ${String(counts['medium'] ?? 0)} medium · ` +
      `${String(counts['high'] ?? 0)} high · ${String(counts['critical'] ?? 0)} critical · ` +
      `${String(exact)} exact / ${String(fuzzy)} fuzzy`,
  );

  // The prediction in docs/alerting.md §7 is the contract. A seeder that quietly produced a
  // different distribution would make the document wrong and nobody would notice.
  const phoneNumber = raised.filter((r) => r.read === '757508300');
  if (phoneNumber.length !== 0) {
    throw new Error('757508300 raised an alert — the hoarding phone number must never alert');
  }
  if (raised.length !== 7 || exact !== 5 || fuzzy !== 2) {
    throw new Error(
      `expected 7 alerts (5 exact, 2 fuzzy) per docs/alerting.md §7, got ` +
        `${String(raised.length)} (${String(exact)} exact, ${String(fuzzy)} fuzzy)`,
    );
  }
  out('matches docs/alerting.md §7 — and 757508300 raised nothing');
  out('open it:  /alerts');
}

async function remove(): Promise<void> {
  const chosen = await chooseSightings();
  const ids = chosen.map((c) => c.sightingId);
  const deleted = await db.execute<{ id: string }>(sql`
    delete from alerts
     where sighting_id = any(${ids}::uuid[]) or last_sighting_id = any(${ids}::uuid[])
    returning id::text as id
  `);
  out(`removed ${String(deleted.length)} alerts raised from the measured reads`);
  // `audit_log` is append-only and is deliberately left alone: an alert having existed is a fact.
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--remove') ? 'remove' : 'seed';
  try {
    await rawSql`select 1`;
    if (mode === 'remove') await remove();
    else await seed();
  } finally {
    await rawSql.end();
  }
}

await main();
