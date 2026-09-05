/**
 * Prometheus metrics for the API, the sightings consumer, and the estate they describe (D3-10).
 *
 * At 80,000 cameras operability *is* the product: a system nobody can monitor is a system nobody
 * runs. Three rules shape every metric in this file, and each of them is a correction to a mistake
 * this project has already measured:
 *
 * 1. **A null is never exported as a zero.** `measured_fps IS NULL` means "could not measure" —
 *    D1-05 (#9) hit that twice. The series is *absent* for such a camera, and a companion marker
 *    (`saakshi_camera_fps_unmeasurable{camera,reason}`) says why. A graph that drew null as 0 would
 *    condemn a camera for the network's behaviour. The same applies to an unscored camera:
 *    `saakshi_camera_unbanded`, never a band of `untrusted`.
 * 2. **`pts_drift_ms` means two different things**, so the gauge carries the meaning as a label.
 *    Live → encoder clock drift, worth alerting on. VOD → pull-rate skew, meaningless. Every
 *    sandbox row is VOD, so an alert on raw drift would fire constantly and truthfully say nothing.
 * 3. **Rate is per camera, against that camera's own baseline.** Over one 22-minute soak `cam04`
 *    produced 33,548 sightings and `cam03` produced 67 — a 500× spread in the same city at the same
 *    hour, and `cam03` was not broken (5,582 frames decoded cleanly at 23.16 fps). An estate-wide
 *    read-rate floor would page somebody every night about a quiet road.
 *
 * Everything is prefixed `saakshi_`. The API's own process metrics are prefixed
 * `saakshi_api_node_` so a default Node metric is never mistaken for a domain measurement.
 */
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { sql } from 'drizzle-orm';
import { createServer, type Server } from 'node:http';
import type { Db } from './db/client.js';

/** One registry per process. The consumer and the API are separate processes, so they never mix. */
export const registry = new Registry();

/** The stated benchmark from PROJECT.md §"Stated performance benchmarks". */
export const UPTIME_TARGET_RATIO = 0.99;

/**
 * How long an estate snapshot is reused before the next scrape re-reads the database.
 *
 * Prometheus scrapes every 15 s and Grafana may add ad-hoc queries on top; without a floor, a
 * dashboard with several panels open would run the estate query several times a second.
 */
const ESTATE_TTL_MS = 10_000;
/**
 * The per-camera read-rate baseline is a percentile over a day of history, which is the one
 * genuinely expensive query here. It changes on the scale of hours, so it is refreshed on the scale
 * of minutes.
 */
const BASELINE_TTL_MS = 300_000;

// ── Process ─────────────────────────────────────────────────────────────────────────────────────

const buildInfo = new Gauge({
  name: 'saakshi_build_info',
  help: 'Always 1. The labels carry the component and version.',
  labelNames: ['component', 'version'] as const,
  registers: [registry],
});

const processUp = new Gauge({
  name: 'saakshi_process_up',
  help: 'Always 1 while this process serves /metrics. `up` from Prometheus is the availability signal; this distinguishes "scrape failed" from "process restarted".',
  labelNames: ['component'] as const,
  registers: [registry],
});

const processUptimeSeconds = new Gauge({
  name: 'saakshi_process_uptime_seconds',
  help: 'Seconds since this process started.',
  labelNames: ['component'] as const,
  registers: [registry],
  collect() {
    this.set({ component: componentName }, process.uptime());
  },
});

const uptimeTarget = new Gauge({
  name: 'saakshi_uptime_target_ratio',
  help: 'The uptime target SAAKSHI is measured against (PROJECT.md: >99%). A constant threshold line, never a measurement — the measurement is avg_over_time(up[...]).',
  registers: [registry],
});

let componentName = 'api';

/** Names this process in every process-scoped metric, and stamps the build info gauge. */
export function identifyComponent(component: string, version: string): void {
  componentName = component;
  buildInfo.set({ component, version }, 1);
  processUp.set({ component }, 1);
  uptimeTarget.set(UPTIME_TARGET_RATIO);
}

/** Node runtime metrics. Opt-in so a test registry stays small and deterministic. */
export function enableDefaultMetrics(): void {
  collectDefaultMetrics({ register: registry, prefix: 'saakshi_api_node_' });
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────

const httpRequests = new Counter({
  name: 'saakshi_api_http_requests_total',
  help: 'HTTP requests served, by route template, method and status.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

const httpErrors = new Counter({
  name: 'saakshi_api_http_errors_total',
  help: 'HTTP responses with a 4xx or 5xx status, by class.',
  labelNames: ['method', 'route', 'class'] as const,
  registers: [registry],
});

const httpDuration = new Histogram({
  name: 'saakshi_api_http_request_duration_seconds',
  help: 'Server-side request duration. Buckets straddle the stated <200 ms API latency target so the SLO is readable straight off the histogram.',
  labelNames: ['method', 'route'] as const,
  // 0.2 is deliberately a bucket edge: PROJECT.md states API response latency < 200 ms.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

// ── Platform: database and bus ──────────────────────────────────────────────────────────────────

const dbReachable = new Gauge({
  name: 'saakshi_db_reachable',
  help: '1 when the last metrics refresh reached PostgreSQL, 0 when it did not.',
  registers: [registry],
});

const dbPoolMax = new Gauge({
  name: 'saakshi_db_pool_max',
  help: 'Configured connection ceiling for this API instance (DATABASE_POOL_MAX).',
  registers: [registry],
});

const dbBackends = new Gauge({
  name: 'saakshi_db_backends',
  help: 'Server-side connections to this database, by pg_stat_activity state. Measured on the server rather than in the client pool, because the number that exhausts max_connections is the server-side one.',
  labelNames: ['state'] as const,
  registers: [registry],
});

const busReachable = new Gauge({
  name: 'saakshi_bus_reachable',
  help: '1 when the last metrics refresh reached Valkey, 0 when it did not.',
  registers: [registry],
});

const busStreamLength = new Gauge({
  name: 'saakshi_bus_stream_length',
  help: 'Entries currently held in a Valkey stream.',
  labelNames: ['stream'] as const,
  registers: [registry],
});

const busGroupPending = new Gauge({
  name: 'saakshi_bus_group_pending_entries',
  help: 'Entries delivered to a consumer group and not yet acknowledged.',
  labelNames: ['stream', 'group'] as const,
  registers: [registry],
});

const busGroupLag = new Gauge({
  name: 'saakshi_bus_group_lag_entries',
  help: 'Entries in the stream the group has never been delivered. This is the number that rises when a consumer is down; pending is the number that rises when a consumer is stuck.',
  labelNames: ['stream', 'group'] as const,
  registers: [registry],
});

const busGroupConsumers = new Gauge({
  name: 'saakshi_bus_group_consumers',
  help: 'Consumers registered in a group. 0 with a rising lag means nothing is draining the stream.',
  labelNames: ['stream', 'group'] as const,
  registers: [registry],
});

// ── Estate: per camera ──────────────────────────────────────────────────────────────────────────

const cameraDeclaredFps = new Gauge({
  name: 'saakshi_camera_declared_fps',
  help: 'Frame rate the camera claims, from the registry. Never trusted — it is here so the gap to measured and effective can be drawn.',
  labelNames: ['camera'] as const,
  registers: [registry],
});

const cameraMeasuredFps = new Gauge({
  name: 'saakshi_camera_measured_fps',
  help: "The stream's own rate, counted from PTS by the trust prober. ABSENT, never zero, when it could not be measured — see saakshi_camera_fps_unmeasurable.",
  labelNames: ['camera'] as const,
  registers: [registry],
});

const cameraFpsUnmeasurable = new Gauge({
  name: 'saakshi_camera_fps_unmeasurable',
  help: 'Always 1. Present only for a camera whose frame rate could NOT be measured; the reason label distinguishes "too slow to measure" from "no measurable frame rate".',
  labelNames: ['camera', 'reason'] as const,
  registers: [registry],
});

const cameraTrustScore = new Gauge({
  name: 'saakshi_camera_trust_score',
  help: 'Composite trust score 0-100. Absent for a camera that has never been scored.',
  labelNames: ['camera'] as const,
  registers: [registry],
});

const cameraTrustBand = new Gauge({
  name: 'saakshi_camera_trust_band',
  help: "Always 1, on the camera's current band. Absent entirely for a camera that has never been probed — see saakshi_camera_unbanded.",
  labelNames: ['camera', 'band'] as const,
  registers: [registry],
});

const cameraUnbanded = new Gauge({
  name: 'saakshi_camera_unbanded',
  help: 'Always 1. Present for a camera with no trust score at all. "Never probed" is not a low score and must not be drawn as one.',
  labelNames: ['camera'] as const,
  registers: [registry],
});

const cameraConnectable = new Gauge({
  name: 'saakshi_camera_connectable',
  help: '1 when the last health check reached the camera. Absent when it has never been checked.',
  labelNames: ['camera'] as const,
  registers: [registry],
});

const cameraDecodable = new Gauge({
  name: 'saakshi_camera_decodable',
  help: '1 when the last health check decoded a frame. Absent when it has never been checked.',
  labelNames: ['camera'] as const,
  registers: [registry],
});

const cameraPtsDrift = new Gauge({
  name: 'saakshi_camera_pts_drift_ms',
  help: 'Wall time minus PTS. The meaning label is load-bearing: on a live source this is encoder clock drift and worth alerting on; on VOD it is pull-rate skew and means nothing. Every sandbox row is VOD.',
  labelNames: ['camera', 'meaning'] as const,
  registers: [registry],
});

const cameraBlur = new Gauge({
  name: 'saakshi_camera_blur_score',
  help: 'Variance of Laplacian on the last probe. Spans five orders of magnitude across this estate — do not scale it linearly.',
  labelNames: ['camera'] as const,
  registers: [registry],
});

const cameraLuma = new Gauge({
  name: 'saakshi_camera_luma_mean',
  help: 'Mean luma on the last probe.',
  labelNames: ['camera'] as const,
  registers: [registry],
});

const cameraTamper = new Gauge({
  name: 'saakshi_camera_tamper_score',
  help: 'Composite tamper score on the last probe, 0-1.',
  labelNames: ['camera'] as const,
  registers: [registry],
});

const cameraHealthAge = new Gauge({
  name: 'saakshi_camera_health_age_seconds',
  help: 'Age of the newest health check for this camera. A sweep takes 23.6 minutes at pool 4, so a fresh estate legitimately spans that.',
  labelNames: ['camera'] as const,
  registers: [registry],
});

const cameraStatus = new Gauge({
  name: 'saakshi_camera_status',
  help: "Always 1, on the camera's registry health status (unknown|online|degraded|offline). Independent of catalogue_status, which is presence rather than health.",
  labelNames: ['camera', 'status'] as const,
  registers: [registry],
});

const cameraSightingsPerMin = new Gauge({
  name: 'saakshi_camera_sightings_per_min',
  help: 'Sightings written for this camera over the last 5 minutes, per minute.',
  labelNames: ['camera'] as const,
  registers: [registry],
});

const cameraSightingsBaseline = new Gauge({
  name: 'saakshi_camera_sightings_baseline_per_min',
  help: "This camera's own median throughput over the last 24 hours, per minute. The read-rate-collapse rule compares against THIS, not an estate constant: yield spreads 500x between cameras in the same city at the same hour.",
  labelNames: ['camera'] as const,
  registers: [registry],
});

const cameraSightingsStored = new Gauge({
  name: 'saakshi_camera_sightings_stored',
  help: 'Sighting rows stored for this camera. Monotonic within a retention window; use deriv() for a rate.',
  labelNames: ['camera'] as const,
  registers: [registry],
});

// ── Estate: aggregates ──────────────────────────────────────────────────────────────────────────

const estateCameras = new Gauge({
  name: 'saakshi_estate_cameras',
  help: 'Registry cameras by catalogue status (presence in the upstream catalogue).',
  labelNames: ['catalogue_status'] as const,
  registers: [registry],
});

const estateCamerasByBand = new Gauge({
  name: 'saakshi_estate_cameras_by_band',
  help: 'Registry cameras by trust band. "unscored" is its own band and is not folded into untrusted.',
  labelNames: ['band'] as const,
  registers: [registry],
});

const estateCameraUptimeRatio = new Gauge({
  name: 'saakshi_estate_camera_uptime_ratio',
  help: 'Fraction of probed cameras whose newest health check was connectable. Estate availability as observed, not as targeted.',
  registers: [registry],
});

// ── Pipeline outputs held in the database ───────────────────────────────────────────────────────

const plateReadsStored = new Gauge({
  name: 'saakshi_plate_reads_stored',
  help: 'Plate read rows stored.',
  registers: [registry],
});

const plateReadsPerMin = new Gauge({
  name: 'saakshi_plate_reads_per_min',
  help: 'Plate reads written over the last 5 minutes, per minute. ANPR is the only mandatory analytic, so this is the mandatory throughput number.',
  registers: [registry],
});

const alertsStored = new Gauge({
  name: 'saakshi_alerts_stored',
  help: 'Alert rows by status and severity.',
  labelNames: ['status', 'severity'] as const,
  registers: [registry],
});

const alertPtsLatency = new Gauge({
  name: 'saakshi_alert_pts_latency_seconds',
  help: 'End to end: alerts.created_at minus the PTS-derived sighting timestamp, over the last 24 hours. Derived from stored rows so the number survives the consumer exiting; saakshi_pts_to_alert_latency_seconds is the live histogram of the same quantity.',
  labelNames: ['quantile'] as const,
  registers: [registry],
});

const evidenceObjectsStored = new Gauge({
  name: 'saakshi_evidence_objects_stored',
  help: 'Rows carrying an object-store URI, by kind. deriv() over this is the object-store write rate.',
  labelNames: ['kind'] as const,
  registers: [registry],
});

const auditChainEntries = new Gauge({
  name: 'saakshi_audit_chain_entries',
  help: 'Entries in the tamper-evident audit chain (D3-04).',
  registers: [registry],
});

const auditChainForks = new Gauge({
  name: 'saakshi_audit_chain_forks',
  help: 'Distinct prev_hash values claimed by more than one entry. Anything above 0 means the chain forked and the verify endpoint will report it.',
  registers: [registry],
});

// ── Video wall relay (D3-07) ────────────────────────────────────────────────────────────────────

const relayCachedObjects = new Gauge({
  name: 'saakshi_relay_cached_objects',
  help: 'Objects held in the HLS relay cache.',
  registers: [registry],
});
const relayCachedBytes = new Gauge({
  name: 'saakshi_relay_cached_bytes',
  help: 'Bytes held in the HLS relay cache.',
  registers: [registry],
});
const relayHits = new Gauge({
  name: 'saakshi_relay_hits',
  help: 'Relay reads served from cache. Each hit is one request the department gateway never saw.',
  registers: [registry],
});
const relayMisses = new Gauge({
  name: 'saakshi_relay_misses',
  help: 'Relay reads that had to go upstream.',
  registers: [registry],
});
const relayUpstreamRequests = new Gauge({
  name: 'saakshi_relay_upstream_requests',
  help: 'Requests the relay has made to the department gateway.',
  registers: [registry],
});
const relayInFlight = new Gauge({
  name: 'saakshi_relay_in_flight',
  help: 'Upstream fetches running now.',
  registers: [registry],
});
const relayQueued = new Gauge({
  name: 'saakshi_relay_queued',
  help: 'Upstream fetches waiting for a concurrency slot.',
  registers: [registry],
});
const relayUpstreamMeanMs = new Gauge({
  name: 'saakshi_relay_upstream_mean_ms',
  help: 'Rolling mean upstream wall time. D3-07 measured a 6-second HLS segment arriving in 22-49 s.',
  registers: [registry],
});

// ── Consumer metrics — constructed only in the process that consumes ────────────────────────────

/**
 * The sightings consumer's metrics.
 *
 * Built lazily, and only by the consumer process, so the API's `/metrics` never carries a shelf of
 * permanently-zero pipeline series that a dashboard could accidentally sum across two jobs.
 */
export interface ConsumerMetrics {
  entriesRead: Counter<string>;
  sightingsInserted: Counter<string>;
  plateReadsInserted: Counter<string>;
  invalidPayloads: Counter<string>;
  unknownCameras: Counter<string>;
  alertsRaised: Counter<string>;
  correlationFailures: Counter<string>;
  ptsToIngestLatency: Histogram<string>;
  ptsToAlertLatency: Histogram<string>;
  plateReadConfidence: Histogram<string>;
}

let consumerMetricsSingleton: ConsumerMetrics | null = null;

export function consumerMetrics(): ConsumerMetrics {
  if (consumerMetricsSingleton !== null) return consumerMetricsSingleton;
  consumerMetricsSingleton = {
    entriesRead: new Counter({
      name: 'saakshi_consumer_entries_read_total',
      help: 'Stream entries read from the sightings bus.',
      registers: [registry],
    }),
    sightingsInserted: new Counter({
      name: 'saakshi_consumer_sightings_inserted_total',
      help: 'Sighting rows written. Delivery is at-least-once, so this can exceed entries published.',
      registers: [registry],
    }),
    plateReadsInserted: new Counter({
      name: 'saakshi_consumer_plate_reads_inserted_total',
      help: 'Plate read rows written. rate()*60 is ANPR reads per minute.',
      registers: [registry],
    }),
    invalidPayloads: new Counter({
      name: 'saakshi_consumer_invalid_payloads_total',
      help: 'Entries dropped because they were not a valid Sighting. Dropped and counted, never redelivered forever.',
      registers: [registry],
    }),
    unknownCameras: new Counter({
      name: 'saakshi_consumer_unknown_cameras_total',
      help: 'Entries dropped because they named a camera absent from the registry.',
      registers: [registry],
    }),
    alertsRaised: new Counter({
      name: 'saakshi_consumer_alerts_raised_total',
      help: 'Alerts created or bumped by watchlist correlation.',
      registers: [registry],
    }),
    correlationFailures: new Counter({
      name: 'saakshi_consumer_correlation_failures_total',
      help: 'Batches whose watchlist correlation threw. Counted, never fatal — ingest outlives the watchlist.',
      registers: [registry],
    }),
    ptsToIngestLatency: new Histogram({
      name: 'saakshi_pts_to_ingest_latency_seconds',
      help: 'Now minus the PTS-derived sighting timestamp, at the moment the row is written.',
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
      registers: [registry],
    }),
    ptsToAlertLatency: new Histogram({
      name: 'saakshi_pts_to_alert_latency_seconds',
      help: 'END TO END: now minus the PTS-derived sighting timestamp, at the moment watchlist correlation raised an alert for it. Timing is PTS-anchored on both ends, never frame arrival time.',
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
      registers: [registry],
    }),
    plateReadConfidence: new Histogram({
      name: 'saakshi_plate_read_confidence',
      help: 'Confidence of every plate read written. A distribution, not an accuracy claim — docs/anpr-accuracy.md carries measured precision and recall.',
      buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1],
      registers: [registry],
    }),
  };
  return consumerMetricsSingleton;
}

// ── Estate refresh ──────────────────────────────────────────────────────────────────────────────

type EstateRow = {
  external_id: string;
  status: string;
  catalogue_status: string;
  declared_fps: string | null;
  trust_score: string | null;
  band: string | null;
  connectable: boolean | null;
  decodable: boolean | null;
  measured_fps: string | null;
  unmeasurable_reason: string | null;
  pts_drift_ms: number | null;
  pts_drift_meaning: string | null;
  blur_score: string | null;
  luma_mean: string | null;
  tamper_score: string | null;
  health_age_s: string | null;
};

type CountRow = {
  key: string;
  n: string;
};

function num(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Trust band thresholds.
 *
 * The same boundaries `services/trust.ts` uses. Read from the shared weights file so a threshold
 * change moves the dashboard with the map rather than leaving them disagreeing.
 */
export interface BandThresholds {
  trusted: number;
  degraded: number;
}

/**
 * One query for the whole estate.
 *
 * A join to the newest health check per camera rather than a query per camera: at 80,000 cameras
 * the per-camera shape is 80,000 round trips per scrape, which is a monitoring system that takes
 * the thing it monitors down.
 */
const ESTATE_SQL = (bands: BandThresholds) => sql`
  with newest as (
    select distinct on (camera_id)
      camera_id, checked_at, connectable, decodable, measured_fps, pts_drift_ms,
      blur_score, luma_mean, tamper_score, breakdown
    from camera_health_checks
    order by camera_id, checked_at desc
  )
  select
    c.external_id,
    c.status::text                              as status,
    c.catalogue_status::text                    as catalogue_status,
    c.declared_fps::text                        as declared_fps,
    c.trust_score::text                         as trust_score,
    case
      when c.trust_score is null then null
      when n.connectable is false then 'dead'
      when c.trust_score >= ${bands.trusted} then 'trusted'
      when c.trust_score >= ${bands.degraded} then 'degraded'
      else 'untrusted'
    end                                         as band,
    n.connectable,
    n.decodable,
    n.measured_fps::text                        as measured_fps,
    n.breakdown -> 'fps' ->> 'unmeasurable_reason' as unmeasurable_reason,
    n.pts_drift_ms,
    n.breakdown ->> 'pts_drift_meaning'         as pts_drift_meaning,
    n.blur_score::text                          as blur_score,
    n.luma_mean::text                           as luma_mean,
    n.tamper_score::text                        as tamper_score,
    extract(epoch from (now() - n.checked_at))::text as health_age_s
  from cameras c
  left join newest n on n.camera_id = c.id
  where c.deleted_at is null
`;

interface EstateSnapshot {
  at: number;
}

const estateCache: EstateSnapshot = { at: 0 };
const baselineCache: EstateSnapshot = { at: 0 };

/**
 * Repopulates every database-derived gauge.
 *
 * `reset()` before each family is what makes a camera that disappears from the registry disappear
 * from the metrics too — without it, a deleted camera would keep reporting its last value forever.
 */
export async function refreshEstateMetrics(db: Db, bands: BandThresholds): Promise<void> {
  const rows = await db.execute<EstateRow>(ESTATE_SQL(bands));

  cameraDeclaredFps.reset();
  cameraMeasuredFps.reset();
  cameraFpsUnmeasurable.reset();
  cameraTrustScore.reset();
  cameraTrustBand.reset();
  cameraUnbanded.reset();
  cameraConnectable.reset();
  cameraDecodable.reset();
  cameraPtsDrift.reset();
  cameraBlur.reset();
  cameraLuma.reset();
  cameraTamper.reset();
  cameraHealthAge.reset();
  cameraStatus.reset();
  estateCameras.reset();
  estateCamerasByBand.reset();

  const byCatalogue = new Map<string, number>();
  const byBand = new Map<string, number>();
  let probed = 0;
  let connectableCount = 0;

  for (const row of rows) {
    const camera = row.external_id;
    cameraStatus.set({ camera, status: row.status }, 1);
    byCatalogue.set(row.catalogue_status, (byCatalogue.get(row.catalogue_status) ?? 0) + 1);

    const declared = num(row.declared_fps);
    if (declared !== null) cameraDeclaredFps.set({ camera }, declared);

    const trust = num(row.trust_score);
    if (trust === null) {
      // Never probed is not a low score. It gets its own series so a panel cannot draw it as one.
      cameraUnbanded.set({ camera }, 1);
      byBand.set('unscored', (byBand.get('unscored') ?? 0) + 1);
    } else {
      cameraTrustScore.set({ camera }, trust);
      const band = row.band ?? 'unscored';
      cameraTrustBand.set({ camera, band }, 1);
      byBand.set(band, (byBand.get(band) ?? 0) + 1);
    }

    if (row.connectable !== null) {
      probed += 1;
      if (row.connectable) connectableCount += 1;
      cameraConnectable.set({ camera }, row.connectable ? 1 : 0);
    }
    if (row.decodable !== null) cameraDecodable.set({ camera }, row.decodable ? 1 : 0);

    const measured = num(row.measured_fps);
    if (measured !== null) {
      cameraMeasuredFps.set({ camera }, measured);
    } else if (row.connectable !== null) {
      // Only for a camera that was actually probed: an absent measurement on a never-probed camera
      // is not an unmeasurable frame rate, it is no attempt.
      cameraFpsUnmeasurable.set({ camera, reason: row.unmeasurable_reason ?? 'unknown' }, 1);
    }

    if (row.pts_drift_ms !== null) {
      cameraPtsDrift.set({ camera, meaning: row.pts_drift_meaning ?? 'unknown' }, row.pts_drift_ms);
    }

    const blur = num(row.blur_score);
    if (blur !== null) cameraBlur.set({ camera }, blur);
    const luma = num(row.luma_mean);
    if (luma !== null) cameraLuma.set({ camera }, luma);
    const tamper = num(row.tamper_score);
    if (tamper !== null) cameraTamper.set({ camera }, tamper);
    const age = num(row.health_age_s);
    if (age !== null) cameraHealthAge.set({ camera }, age);
  }

  for (const [key, n] of byCatalogue) estateCameras.set({ catalogue_status: key }, n);
  for (const [key, n] of byBand) estateCamerasByBand.set({ band: key }, n);
  estateCameraUptimeRatio.set(probed === 0 ? 0 : connectableCount / probed);
}

/** Sighting volume and rate per camera, plus the stored plate/alert/audit/evidence totals. */
export async function refreshPipelineMetrics(db: Db): Promise<void> {
  const recent = await db.execute<CountRow>(sql`
    select c.external_id as key, count(s.*)::text as n
      from cameras c
      left join sightings s
        on s.camera_id = c.id and s.ts > now() - interval '5 minutes'
     where c.deleted_at is null
     group by c.external_id
  `);
  cameraSightingsPerMin.reset();
  for (const row of recent) cameraSightingsPerMin.set({ camera: row.key }, Number(row.n) / 5);

  const stored = await db.execute<CountRow>(sql`
    select c.external_id as key, count(s.*)::text as n
      from cameras c
      left join sightings s on s.camera_id = c.id
     where c.deleted_at is null
     group by c.external_id
  `);
  cameraSightingsStored.reset();
  for (const row of stored) cameraSightingsStored.set({ camera: row.key }, Number(row.n));

  const plates = await db.execute<{ stored: string; recent: string }>(sql`
    select count(*)::text as stored,
           count(*) filter (where created_at > now() - interval '5 minutes')::text as recent
      from plate_reads
  `);
  const plateRow = plates[0];
  if (plateRow !== undefined) {
    plateReadsStored.set(Number(plateRow.stored));
    plateReadsPerMin.set(Number(plateRow.recent) / 5);
  }

  const alertRows = await db.execute<{ status: string; severity: string; n: string }>(sql`
    select status::text as status, severity::text as severity, count(*)::text as n
      from alerts group by 1, 2
  `);
  alertsStored.reset();
  for (const row of alertRows) {
    alertsStored.set({ status: row.status, severity: row.severity }, Number(row.n));
  }

  // The deck's end-to-end number, computed from stored rows so it survives the consumer exiting.
  const latency = await db.execute<{ p50: string | null; p95: string | null; max: string | null }>(
    sql`
      select
        percentile_cont(0.5) within group (
          order by extract(epoch from (created_at - sighting_ts))
        )::text as p50,
        percentile_cont(0.95) within group (
          order by extract(epoch from (created_at - sighting_ts))
        )::text as p95,
        max(extract(epoch from (created_at - sighting_ts)))::text as max
      from alerts
      where created_at > now() - interval '24 hours'
    `,
  );
  const latencyRow = latency[0];
  alertPtsLatency.reset();
  if (latencyRow !== undefined) {
    const p50 = num(latencyRow.p50);
    const p95 = num(latencyRow.p95);
    const worst = num(latencyRow.max);
    if (p50 !== null) alertPtsLatency.set({ quantile: 'p50' }, p50);
    if (p95 !== null) alertPtsLatency.set({ quantile: 'p95' }, p95);
    if (worst !== null) alertPtsLatency.set({ quantile: 'max' }, worst);
  }

  const evidence = await db.execute<{ vehicle: string; plate: string }>(sql`
    select
      (select count(*) from sightings where crop_uri is not null)::text   as vehicle,
      (select count(*) from plate_reads where crop_uri is not null)::text as plate
  `);
  const evidenceRow = evidence[0];
  if (evidenceRow !== undefined) {
    evidenceObjectsStored.set({ kind: 'vehicle_crop' }, Number(evidenceRow.vehicle));
    evidenceObjectsStored.set({ kind: 'plate_crop' }, Number(evidenceRow.plate));
  }

  const audit = await db.execute<{ entries: string; forks: string }>(sql`
    select
      (select count(*) from audit_log)::text as entries,
      (select count(*) from (
         select prev_hash from audit_log group by prev_hash having count(*) > 1
       ) f)::text as forks
  `);
  const auditRow = audit[0];
  if (auditRow !== undefined) {
    auditChainEntries.set(Number(auditRow.entries));
    auditChainForks.set(Number(auditRow.forks));
  }

  const backends = await db.execute<CountRow>(sql`
    select coalesce(state, 'unknown') as key, count(*)::text as n
      from pg_stat_activity
     where datname = current_database()
     group by 1
  `);
  dbBackends.reset();
  for (const row of backends) dbBackends.set({ state: row.key }, Number(row.n));
}

/**
 * Each camera's own median throughput.
 *
 * The read-rate-collapse alert compares against this rather than an estate-wide floor, because
 * per-camera yield spread 500x on real data (`cam04` 33,548 sightings against `cam03` 67, in the
 * same city at the same hour). A camera that has always been quiet must not page anybody.
 *
 * Bounded to 24 hours. At estate scale this belongs in a Timescale continuous aggregate rather than
 * an ad-hoc percentile; `docs/observability.md` says so rather than leaving it to be discovered.
 */
export async function refreshBaselineMetrics(db: Db): Promise<void> {
  const rows = await db.execute<CountRow>(sql`
    with per_minute as (
      select c.external_id as key, date_trunc('minute', s.ts) as minute, count(*) as n
        from cameras c
        join sightings s on s.camera_id = c.id
       where c.deleted_at is null and s.ts > now() - interval '24 hours'
       group by 1, 2
    )
    select key, percentile_cont(0.5) within group (order by n)::text as n
      from per_minute group by key
  `);
  cameraSightingsBaseline.reset();
  for (const row of rows) cameraSightingsBaseline.set({ camera: row.key }, Number(row.n));
}

// ── Bus refresh ─────────────────────────────────────────────────────────────────────────────────

/** The slice of a Valkey client the bus gauges need — narrow, so a test needs no broker. */
export interface BusInspector {
  streamLength(stream: string): Promise<number>;
  groups(
    stream: string,
  ): Promise<{ name: string; pending: number; lag: number; consumers: number }[]>;
}

export async function refreshBusMetrics(inspector: BusInspector, streams: string[]): Promise<void> {
  busStreamLength.reset();
  busGroupPending.reset();
  busGroupLag.reset();
  busGroupConsumers.reset();
  for (const stream of streams) {
    busStreamLength.set({ stream }, await inspector.streamLength(stream));
    for (const group of await inspector.groups(stream)) {
      busGroupPending.set({ stream, group: group.name }, group.pending);
      busGroupLag.set({ stream, group: group.name }, group.lag);
      busGroupConsumers.set({ stream, group: group.name }, group.consumers);
    }
  }
}

export function setBusReachable(reachable: boolean): void {
  busReachable.set(reachable ? 1 : 0);
}

export function setDbReachable(reachable: boolean): void {
  dbReachable.set(reachable ? 1 : 0);
}

export function setDbPoolMax(max: number): void {
  dbPoolMax.set(max);
}

// ── Relay ───────────────────────────────────────────────────────────────────────────────────────

export interface RelayStatsLike {
  readonly cachedObjects: number;
  readonly cachedBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly upstreamRequests: number;
  readonly inFlight: number;
  readonly queued: number;
  readonly meanUpstreamMs: number;
}

export function recordRelayStats(stats: RelayStatsLike): void {
  relayCachedObjects.set(stats.cachedObjects);
  relayCachedBytes.set(stats.cachedBytes);
  relayHits.set(stats.hits);
  relayMisses.set(stats.misses);
  relayUpstreamRequests.set(stats.upstreamRequests);
  relayInFlight.set(stats.inFlight);
  relayQueued.set(stats.queued);
  relayUpstreamMeanMs.set(stats.meanUpstreamMs);
}

// ── HTTP instrumentation ────────────────────────────────────────────────────────────────────────

export function observeHttp(
  method: string,
  route: string,
  status: number,
  durationSeconds: number,
): void {
  const code = String(status);
  httpRequests.inc({ method, route, status: code });
  httpDuration.observe({ method, route }, durationSeconds);
  if (status >= 400) {
    httpErrors.inc({ method, route, class: status >= 500 ? '5xx' : '4xx' });
  }
}

// ── Standalone exporter, for processes with no HTTP server of their own ─────────────────────────

/**
 * Serves `/metrics` on its own port.
 *
 * The sightings consumer is a CLI, not a server, and it is the only process positioned to observe
 * PTS -> alert end to end. Rather than teach it Fastify, it gets sixteen lines of `node:http`.
 */
export function startMetricsServer(port: number, host = '0.0.0.0'): Server {
  const server = createServer((req, res) => {
    if (req.url?.split('?')[0] !== '/metrics') {
      res.writeHead(404).end('not found\n');
      return;
    }
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': registry.contentType }).end(body);
      })
      .catch(() => {
        res.writeHead(500).end('metrics collection failed\n');
      });
  });
  server.listen(port, host);
  // A metrics port must never hold the process open past its work.
  server.unref();
  return server;
}

/** Renders the registry. Exposed so a test can assert on the exposition text. */
export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export const METRICS_CACHE = { ESTATE_TTL_MS, BASELINE_TTL_MS };

/** True when a cached snapshot has aged out; stamps the cache when it has. */
export function dueForRefresh(cache: 'estate' | 'baseline', now = Date.now()): boolean {
  const entry = cache === 'estate' ? estateCache : baselineCache;
  const ttl = cache === 'estate' ? ESTATE_TTL_MS : BASELINE_TTL_MS;
  if (now - entry.at < ttl) return false;
  entry.at = now;
  return true;
}
