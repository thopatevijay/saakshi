/**
 * `npm run consume:sightings`
 *
 * Drains the Valkey `sightings` stream into Postgres until interrupted. Mirrors the shape of the
 * other jobs in this package (`sync:catalogue`, `trust:recompute`) rather than inventing a new one.
 *
 *   npm run consume:sightings                 # follow the stream, Ctrl-C to stop
 *   npm run consume:sightings -- --drain      # exit once the stream is empty (the gate run's mode)
 *   npm run consume:sightings -- --no-alerts  # ingest only, no watchlist correlation (D2-06)
 *   npm run consume:sightings -- --metrics-port 9464   # expose /metrics for Prometheus (D3-10)
 *
 * **This process is where PTS → alert latency is measurable.** The worker's timestamps are
 * PTS-anchored, the alert is created here, and nothing in between re-stamps a wall clock. So the
 * end-to-end number the deck quotes is `now - sighting.ts` observed at correlation time, exported
 * as `saakshi_pts_to_alert_latency_seconds`.
 */
import 'dotenv/config';
import { loadEnv } from '../env.js';
import { createDb, createSql } from '../db/client.js';
import { consumeSightings, SIGHTINGS_GROUP, SIGHTINGS_STREAM } from './sightings.js';
import { createValkeyReader } from './valkey-reader.js';
import { AlertEngine } from '../services/alerts.js';
import { createWatchlistRegistry } from '../watchlist/index.js';
import { ConfusionPlateMatcher } from '../services/plate-search.js';
import { consumerMetrics, identifyComponent, startMetricsServer } from '../metrics.js';

const env = loadEnv();
const drain = process.argv.includes('--drain');

/** `--metrics-port N`, or `METRICS_PORT`. Off unless asked for: a CLI that binds a port nobody
 *  requested is a CLI that fails on the second copy you run. */
function metricsPort(): number | null {
  const index = process.argv.indexOf('--metrics-port');
  const raw = index === -1 ? process.env['METRICS_PORT'] : process.argv[index + 1];
  if (raw === undefined || raw === '') return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`--metrics-port expects a port number, got ${raw}`);
  }
  return port;
}
const rawSql = createSql(env.DATABASE_URL, 4);
const db = createDb(rawSql);
const reader = createValkeyReader(env.VALKEY_URL);

// D2-06's alert engine. `--no-alerts` skips it, for an ingest-only run on a machine with no
// watchlist — the correlation is a feature of the pipeline, not a precondition for it.
const alerts = !process.argv.includes('--no-alerts');
const engine = alerts
  ? new AlertEngine({
      db,
      registry: createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) }),
    })
  : undefined;

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

// D3-10. Constructed only in this process, so the API's /metrics never carries a shelf of
// permanently-zero pipeline series that a dashboard could sum across two jobs by accident.
const port = metricsPort();
const metrics = port === null ? null : consumerMetrics();
if (port !== null) {
  identifyComponent('sightings-consumer', '0.1.0');
  startMetricsServer(port);
  console.log(`metrics on :${String(port)}/metrics`);
}

/** Cumulative counter values already exported, so each batch advances by its delta. */
const counted = {
  entriesRead: 0,
  invalidPayloads: 0,
  unknownCameras: 0,
  alertsRaised: 0,
  correlationFailures: 0,
};

console.log(
  `consuming ${SIGHTINGS_STREAM} as group ${SIGHTINGS_GROUP}${drain ? ' (drain mode)' : ''}`,
);

try {
  const stats = await consumeSightings({
    reader,
    db,
    signal: controller.signal,
    // Drain mode exits after two empty polls; following mode never does. Two rather than one so a
    // batch that lands between polls is not mistaken for the end of the stream.
    maxIdlePolls: drain ? 2 : Infinity,
    blockMs: drain ? 1_000 : 5_000,
    ...(engine === undefined ? {} : { alertEngine: engine }),
    ...(metrics === null
      ? {}
      : {
          onIngest: (observation) => {
            const now = Date.now();
            metrics.sightingsInserted.inc(observation.sightingTimestamps.length);
            for (const ts of observation.sightingTimestamps) {
              const pts = Date.parse(ts);
              // A payload with an unparseable timestamp is already dropped upstream by zod; this
              // guard exists so a clock oddity can never poison the histogram with a NaN.
              if (Number.isFinite(pts)) {
                metrics.ptsToIngestLatency.observe((now - pts) / 1000);
              }
            }
            metrics.plateReadsInserted.inc(observation.plateReadConfidences.length);
            for (const confidence of observation.plateReadConfidences) {
              metrics.plateReadConfidence.observe(confidence);
            }
            for (const item of observation.correlated) {
              if (item.alerts === 0) continue;
              const pts = Date.parse(item.sightingTs);
              if (!Number.isFinite(pts)) continue;
              // Observed once per alert raised, so a plate that matches two watchlist entries
              // contributes two samples — the histogram counts alerts, not plate reads.
              for (let i = 0; i < item.alerts; i += 1) {
                metrics.ptsToAlertLatency.observe((now - pts) / 1000);
              }
            }
          },
        }),
    onBatch: (inserted, running) => {
      if (metrics !== null) {
        // Counters are monotonic, so they are advanced by the delta since the last batch rather
        // than set — `stats` is cumulative for the whole run.
        metrics.entriesRead.inc(running.entriesRead - counted.entriesRead);
        metrics.invalidPayloads.inc(running.invalidPayloads - counted.invalidPayloads);
        metrics.unknownCameras.inc(running.unknownCameras - counted.unknownCameras);
        metrics.alertsRaised.inc(running.alertsRaised - counted.alertsRaised);
        metrics.correlationFailures.inc(running.correlationFailures - counted.correlationFailures);
        counted.entriesRead = running.entriesRead;
        counted.invalidPayloads = running.invalidPayloads;
        counted.unknownCameras = running.unknownCameras;
        counted.alertsRaised = running.alertsRaised;
        counted.correlationFailures = running.correlationFailures;
      }
      console.log(`  +${String(inserted)} rows  (total ${String(running.inserted)})`);
    },
  });

  console.log('');
  console.log(`  entries read      ${String(stats.entriesRead)}`);
  console.log(`  rows inserted     ${String(stats.inserted)}`);
  console.log(`  plate reads       ${String(stats.plateReadsInserted)}`);
  console.log(`  invalid payloads  ${String(stats.invalidPayloads)}`);
  console.log(`  unknown cameras   ${String(stats.unknownCameras)}`);
  console.log(
    `  alerts raised     ${String(stats.alertsRaised)}${alerts ? '' : ' (correlation off)'}`,
  );
  if (stats.correlationFailures > 0) {
    console.log(`  correlation fails ${String(stats.correlationFailures)}`);
  }
  if (stats.unknownCameraIds.length > 0) {
    console.log(`  unknown ids       ${stats.unknownCameraIds.join(', ')}`);
  }
  console.log('');
} finally {
  await reader.close();
  await rawSql.end();
}
