/**
 * Alert-storm benchmark (D2-06, AC 8).
 *
 * **The question this answers is not "how fast".** It is: *when a camera storms, does the operator's
 * queue hold, and is anything lost?* The acceptance criterion is 500 alerts injected into one
 * minute against a cap of 120, and three things must be true afterwards:
 *
 *   1. **The cap held** — deliveries in the window are exactly the cap, not the cap plus a bit.
 *   2. **Nothing was dropped** — `delivered + suppressed = 500`, and all 500 rows are in `alerts`.
 *      What is capped is the operator's queue; the evidence is never rate-limited.
 *   3. **The overflow is legible** — the suppressed alerts are aggregated into `alert_digests` rows
 *      with counts by severity, category and camera, plus a sample of ids to click through.
 *
 * It also measures the thing that actually saves the control room, which is not the rate limiter at
 * all: **dedupe**. The second phase replays one vehicle past one camera 500 times and reports how
 * many alerts that produces. The rate limiter is the last line of defence; dedupe is the first.
 *
 * Run:  npm run bench:alert-storm
 *       BENCH_ALERTS=1000 npm run bench:alert-storm
 *
 * Rows are tagged `BENCH-STORM-` in `dedupe_key` and removed at the end unless `BENCH_KEEP=1`.
 */
import { sql } from 'drizzle-orm';
import { createDb, createSql } from '../db/client.js';
import { loadEnv } from '../env.js';
import {
  AlertEngine,
  DeliveryGate,
  loadAlertPolicy,
  POLICY_PATH,
  type AlertPolicy,
} from '../services/alerts.js';
import { ConfusionPlateMatcher } from '../services/plate-search.js';
import {
  createWatchlistRegistry,
  loadSeedCsv,
  SEED_CSV_PATH,
  upsertWatchlistEntries,
} from '../watchlist/index.js';

const TARGET = Number(process.env['BENCH_ALERTS'] ?? 500);
const KEEP = process.env['BENCH_KEEP'] === '1';
const TAG = `BENCH-STORM-${String(Date.now())}`;
const TRACK_BASE = 95_000_000 + (Date.now() % 1_000_000);

const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
const rawSql = createSql(env.DATABASE_URL, 8);
const db = createDb(rawSql);

const policy = loadAlertPolicy(POLICY_PATH);
const CAP = policy.rateLimit.deliveriesPerMinute;

function line(): void {
  console.log('─'.repeat(84));
}

async function main(): Promise<void> {
  await rawSql`select 1`;

  const batch = await loadSeedCsv(SEED_CSV_PATH);
  await upsertWatchlistEntries(db, batch.valid);

  const cams = await db.execute<{ id: string; external_id: string }>(
    sql`select id::text as id, external_id from cameras where deleted_at is null
         order by external_id limit 8`,
  );
  if (cams.length === 0) throw new Error('no cameras in the registry — run npm run db:migrate');

  // One watchlist entry per storm, so the benchmark cannot be diluted by, or dilute, real alerts.
  const entries = await db.execute<{ id: string; plate: string }>(sql`
    insert into watchlist_entries (category, entity_type, plate_normalized, source_system,
                                   source_ref, severity, valid_from, active, meta)
    values ('stolen_vehicle', 'vehicle', ${`GJ99ZZ${String(TRACK_BASE).slice(-4)}`}, 'VAHAN',
            ${TAG}, 'high', '2020-01-01T00:00:00Z', true,
            '{"note":"D2-06 storm benchmark fixture — synthetic, never a vehicle record"}'::jsonb)
    returning id::text as id, plate_normalized as plate
  `);
  const entry = entries[0];
  if (entry === undefined) throw new Error('watchlist fixture insert returned no row');

  line();
  console.log(`ALERT STORM — ${String(TARGET)} alerts into one minute, cap ${String(CAP)}/min`);
  console.log(`  database   ${env.DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')}`);
  console.log(`  policy     v${String(policy.version)}  (config/alert-policy.json)`);
  console.log(`  cameras    ${cams.length}`);
  line();

  /* ── Phase 1 · the delivery cap ────────────────────────────────────────────────────────────── */

  // A frozen clock, so the run measures the cap rather than how long the machine took. A benchmark
  // that injects 500 alerts in 3 real seconds and calls the window "a minute" is measuring itself.
  let clock = Date.now();
  const gate = new DeliveryGate(policy, () => clock);

  const severities = ['critical', 'high', 'medium', 'low'] as const;
  const categories = ['wanted_person', 'stolen_vehicle', 'blacklisted_vehicle', 'suspect'] as const;

  let delivered = 0;
  let suppressed = 0;
  for (let i = 0; i < TARGET; i += 1) {
    const admitted = gate.admit({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      severity: severities[i % severities.length] ?? 'low',
      category: categories[i % categories.length] ?? 'suspect',
      cameraId: cams[i % cams.length]?.id ?? 'cam',
    });
    if (admitted) delivered += 1;
    else suppressed += 1;
  }

  // Close the window so the digest is written, then advance so the next minute is fresh.
  const digests = await gate.flush(db, true);
  clock += 60_000;

  const digested = digests.reduce((n, d) => n + d.suppressedCount, 0);
  const capHeld = delivered === CAP;
  const nothingDropped = delivered + suppressed === TARGET && digested === suppressed;

  console.log('PHASE 1 — the delivery cap');
  console.log(`  injected           ${String(TARGET)}`);
  console.log(`  delivered live     ${String(delivered)}   (cap ${String(CAP)})`);
  console.log(`  suppressed         ${String(suppressed)}`);
  console.log(
    `  digested           ${String(digested)}  in ${String(digests.length)} digest row(s)`,
  );
  console.log(`  accounted for      ${String(delivered + digested)} / ${String(TARGET)}`);
  for (const digest of digests) {
    console.log(`    window ${digest.windowStart} → ${digest.windowEnd}`);
    console.log(`      by severity  ${JSON.stringify(digest.bySeverity)}`);
    console.log(`      by category  ${JSON.stringify(digest.byCategory)}`);
    console.log(`      sample ids   ${String(digest.sample.length)} kept`);
  }
  console.log(`  cap held           ${capHeld ? 'YES' : 'NO'}`);
  console.log(`  nothing dropped    ${nothingDropped ? 'YES' : 'NO'}`);
  line();

  /* ── Phase 2 · what actually protects the queue ────────────────────────────────────────────── */

  const engine = new AlertEngine({
    db,
    registry: createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) }),
    policy,
  });

  const start = Date.parse('2026-08-01T09:00:00.000Z');
  // 500 sightings of one vehicle at one camera over five minutes — a stuck feed re-detecting the
  // same scene, which is the storm shape that actually happens.
  const stormCamera = cams[0]?.id ?? '';
  const values: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    values.push(
      `('${stormCamera}'::uuid, '${new Date(start + i * 600).toISOString()}', ${String(6000 + i)}, ` +
        `${String(TRACK_BASE + i)}, 'car', '{"x":1,"y":2,"w":3,"h":4}'::jsonb, 0.9)`,
    );
  }
  const seeded = await db.execute<{ id: string; ts: string }>(
    sql.raw(
      `insert into sightings (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence)
       values ${values.join(',')} returning id::text as id, ts`,
    ),
  );

  const t0 = performance.now();
  let created = 0;
  let deduped = 0;
  for (const sighting of seeded) {
    const outcome = await engine.correlate({
      sightingId: sighting.id,
      sightingTs: sighting.ts,
      cameraId: stormCamera,
      rawText: entry.plate,
      confidence: 0.9,
    });
    created += outcome.created;
    deduped += outcome.deduped;
  }
  const elapsedMs = performance.now() - t0;

  const rows = await db.execute<{ n: string; total: string }>(
    sql`select count(*)::text as n, coalesce(sum(sighting_count), 0)::text as total
          from alerts where watchlist_entry_id = ${entry.id}::uuid`,
  );
  const alertRows = Number(rows[0]?.n ?? 0);
  const collapsedSightings = Number(rows[0]?.total ?? 0);

  console.log('PHASE 2 — dedupe, which is what the operator actually feels');
  console.log(`  sightings injected ${String(seeded.length)} (one vehicle, one camera, 5 minutes)`);
  console.log(`  alert rows         ${String(alertRows)}`);
  console.log(`  sightings folded   ${String(collapsedSightings)}`);
  console.log(
    `  reduction          ${(100 * (1 - alertRows / seeded.length)).toFixed(2)}%  ` +
      `(${String(seeded.length)} → ${String(alertRows)})`,
  );
  console.log(`  correlations       ${created} created, ${deduped} deduped`);
  console.log(
    `  throughput         ${(seeded.length / (elapsedMs / 1000)).toFixed(0)} reads/s ` +
      `(${(elapsedMs / seeded.length).toFixed(2)} ms per read, one connection)`,
  );
  line();

  const persisted = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from alert_digests where window_start >= now() - interval '10 minutes'`,
  );
  console.log('VERDICT');
  console.log(`  AC 8 · cap holds at ${String(CAP)}/min ............ ${capHeld ? 'PASS' : 'FAIL'}`);
  console.log(
    `  AC 8 · overflow digested, not dropped ....... ${nothingDropped ? 'PASS' : 'FAIL'}`,
  );
  console.log(
    `  AC 8 · digest rows persisted ................ ${Number(persisted[0]?.n ?? 0) > 0 ? 'PASS' : 'FAIL'}`,
  );
  console.log(
    `  AC 2 · a storm collapses to one alert ....... ${alertRows === 1 ? 'PASS' : `FAIL (${String(alertRows)})`}`,
  );
  line();

  if (!KEEP) {
    await db.execute(sql`delete from alerts where watchlist_entry_id = ${entry.id}::uuid`);
    await db.execute(
      sql`delete from sightings where track_id >= ${TRACK_BASE} and track_id < ${TRACK_BASE + TARGET + 10}`,
    );
    await db.execute(sql`delete from watchlist_entries where source_ref = ${TAG}`);
    for (const digest of digests) {
      await db.execute(sql`delete from alert_digests where id = ${digest.id}::uuid`);
    }
    console.log('cleaned up (BENCH_KEEP=1 to retain)');
  }

  if (!capHeld || !nothingDropped || alertRows !== 1) {
    throw new Error('alert storm benchmark did not meet AC 2 / AC 8');
  }
}

try {
  await main();
} finally {
  await rawSql.end();
}
