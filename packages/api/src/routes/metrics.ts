/**
 * `GET /metrics` — the Prometheus exposition endpoint (D3-10).
 *
 * Three deliberate choices:
 *
 * - **Unauthenticated, like `/health`.** Prometheus scrapes it from a sibling container on a
 *   private network; the alternative is a credential in `docker-compose.yml` that buys nothing on a
 *   local stack. `docs/observability.md` records this, and D4-01 owns whether the deployed topology
 *   needs the endpoint bound to a private interface.
 * - **`hide: true` in the OpenAPI document.** The body is Prometheus text, not JSON, and it is not
 *   part of the typed web client — documenting it would churn a generated file for no consumer.
 * - **Refreshed inside the handler, not on a timer.** A background timer keeps querying the
 *   database on an idle deployment nobody is watching. Reading on scrape means the query load is
 *   exactly the monitoring load, floored by a short TTL so several open Grafana panels cannot turn
 *   one estate query into several a second.
 */
import type { App } from '../server.js';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { loadWeights } from '../services/trust.js';
import {
  declareUptimeTarget,
  dueForRefresh,
  identifyComponent,
  observeHttp,
  recordRelayStats,
  refreshBaselineMetrics,
  refreshBusMetrics,
  refreshEstateMetrics,
  refreshPipelineMetrics,
  registry,
  setBusReachable,
  setDbPoolMax,
  setDbReachable,
  type BusInspector,
  type RelayStatsLike,
} from '../metrics.js';
import { SIGHTINGS_STREAM } from '../consumers/sightings.js';

/** The evidence stream (D2-11) rides the same bus and has the same failure mode. */
const EVIDENCE_STREAM = 'evidence';

export interface MetricsRouteOptions {
  env: Env;
  /** Omitted for a bare health-only server; every estate gauge needs a connection. */
  db?: Db;
  /** D3-07's HLS relay. Its counters are exported, never re-instrumented. */
  relay?: { stats(): RelayStatsLike };
  /** Read-only Valkey introspection for the bus-lag gauges. Never joins a consumer group. */
  bus?: BusInspector;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Start of the request, for the duration histogram. Set by the metrics onRequest hook. */
    metricsStartedAt?: bigint;
  }
}

export function registerMetricsRoutes(app: App, options: MetricsRouteOptions): void {
  const { env, db, relay, bus } = options;
  const bands = loadWeights().bands;

  identifyComponent('api', '0.1.0');
  declareUptimeTarget();
  setDbPoolMax(env.DATABASE_POOL_MAX);

  app.addHook('onRequest', (request, _reply, done) => {
    request.metricsStartedAt = process.hrtime.bigint();
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const started = request.metricsStartedAt;
    if (started !== undefined) {
      // The route *template*, never the resolved URL: labelling by `/api/v1/cameras/<uuid>` would
      // mint a new time series per camera and take the monitoring system down at estate scale.
      const route = request.routeOptions.url ?? 'unmatched';
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      observeHttp(request.method, route, reply.statusCode, seconds);
    }
    done();
  });

  app.get('/metrics', { schema: { hide: true } }, async (_request, reply) => {
    if (db !== undefined) {
      try {
        if (dueForRefresh('estate')) {
          await refreshEstateMetrics(db, bands);
          await refreshPipelineMetrics(db);
        }
        if (dueForRefresh('baseline')) await refreshBaselineMetrics(db);
        setDbReachable(true);
      } catch (error) {
        // A metrics endpoint that 500s when a dependency is down reports nothing at the moment it
        // matters most. The gauge says the database was unreachable; every other family still
        // renders with its last value.
        setDbReachable(false);
        app.log.warn({ err: error }, 'metrics: estate refresh failed');
      }
    }

    if (bus !== undefined) {
      try {
        await refreshBusMetrics(bus, [SIGHTINGS_STREAM, EVIDENCE_STREAM]);
        setBusReachable(true);
      } catch (error) {
        setBusReachable(false);
        app.log.warn({ err: error }, 'metrics: bus refresh failed');
      }
    }

    if (relay !== undefined) recordRelayStats(relay.stats());

    return reply.header('content-type', registry.contentType).send(await registry.metrics());
  });
}
