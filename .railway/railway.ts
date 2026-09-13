/**
 * SAAKSHI on Railway — Infrastructure as Code (D4-01).
 *
 * This file replaces `railway.json`, which Railway has **deprecated**: pointing a service at one now
 * fails with *"Config as Code (railway.json / railway.toml) is deprecated. Use Infrastructure as
 * Code (.railway/railway.ts) instead."* The two per-package `railway.json` files were therefore
 * committed but inert; this is the version the platform actually reads.
 *
 * Generated with `railway config pull` against the live project, then extended. Pulling first
 * matters: it means the file describes the deployment that exists rather than one someone hoped for,
 * and `railway config plan` reported "already up to date" before anything below was added.
 *
 * **Secrets are `preserve()`** — pulled without `--include-variables`, so every value stays in
 * Railway's variable store and none of it is in git. `preserve()` means "leave whatever is set";
 * it does not clear the variable.
 *
 * **`source: image(...)` is not a mistake.** Each service's *source of record* is its image, and the
 * per-service `RAILWAY_DOCKERFILE_PATH` variable plus `railway up` is what builds it from this
 * repository instead. the Dockerfiles under `ops/` exist because an image service takes its
 * start command from a dashboard field the CLI cannot set, and none of the three runs correctly on
 * its default — see docs/deployment.md § 2.
 *
 *   railway config plan     # preview
 *   railway config apply    # apply
 */
import { defineRailway, image, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const valkeyVolume = volume("valkey-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "asia-southeast1-eqsg3a", sizeMB: 5000 });
  const dbVolume = volume("db-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "asia-southeast1-eqsg3a", sizeMB: 5000 });
  const minioVolume = volume("minio-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "asia-southeast1-eqsg3a", sizeMB: 5000 });
  const web = service("web", {
    replicas: { "asia-southeast1-eqsg3a": 1 },
    // `/` redirects to the login screen (307), which a healthcheck would read as a failure; `/login`
    // is the shallowest route that renders without a session.
    healthcheckPath: "/login",
    healthcheckTimeout: 120,
    sleepApplication: false,
    env: { API_BASE_URL: preserve(), NODE_ENV: preserve(), PMTILES_PATH: preserve(), RAILWAY_DOCKERFILE_PATH: preserve(), SENTINEL_HOST: preserve(), SENTINEL_INGEST_URL: preserve(), SENTINEL_PORTAL_COOKIE: preserve() },
  });
  const api = service("api", {
    replicas: { "asia-southeast1-eqsg3a": 1 },
    // The migration release step, restored. This is what `railway.json` was meant to carry and could
    // not: migrations run once, before the new container takes traffic, rather than racing on boot.
    // It also removes the manual `railway ssh … migrate.js migrate` step the deploy needed until now.
    preDeployCommand: "node packages/api/dist/db/migrate.js migrate",
    healthcheckPath: "/health",
    healthcheckTimeout: 120,
    // A judge clicking the URL must meet a running app, not a cold boot.
    sleepApplication: false,
    // ONE replica, and this is load-bearing rather than thrift. The video-wall relay's cache is
    // in-process and is the pacing mechanism that makes nine wall tiles cost the department gateway
    // one copy of a stream instead of nine — the pacing the organisers explicitly ask clients for.
    // A second replica halves that benefit and divides STREAM_RELAY_CONCURRENCY per replica (D3-07).
    numReplicas: 1,
    env: { ANTHROPIC_MODEL: preserve(), DATABASE_POOL_MAX: preserve(), DATABASE_URL: preserve(), JWT_SECRET: preserve(), MINIO_ACCESS_KEY: preserve(), MINIO_BUCKET: preserve(), MINIO_ENDPOINT: preserve(), MINIO_SECRET_KEY: preserve(), NODE_ENV: preserve(), OPENAI_API_KEY: preserve(), OPENAI_MODEL: preserve(), QUERY_COMPILER: preserve(), RAILWAY_DOCKERFILE_PATH: preserve(), SENTINEL_HOST: preserve(), SENTINEL_INGEST_URL: preserve(), SENTINEL_PORTAL_COOKIE: preserve(), VALKEY_URL: preserve() },
  });
  const minio = service("minio", {
    source: image("minio/minio"),
    replicas: { "asia-southeast1-eqsg3a": 1 },
    volumeMounts: { "/data": minioVolume },
    env: { MINIO_ROOT_PASSWORD: preserve(), MINIO_ROOT_USER: preserve(), RAILWAY_DOCKERFILE_PATH: preserve(), RAILWAY_RUN_UID: preserve() },
  });
  const valkey = service("valkey", {
    source: image("valkey/valkey:8-alpine"),
    replicas: { "asia-southeast1-eqsg3a": 1 },
    volumeMounts: { "/data": valkeyVolume },
    env: { RAILWAY_DOCKERFILE_PATH: preserve(), VALKEY_PASSWORD: preserve() },
  });
  const db = service("db", {
    source: image("timescale/timescaledb-ha:pg16"),
    replicas: { "asia-southeast1-eqsg3a": 1 },
    networking: { tcpProxies: { "5432": {} } },
    volumeMounts: { "/home/postgres/pgdata/data": dbVolume },
    env: { POSTGRES_DB: preserve(), POSTGRES_PASSWORD: preserve(), POSTGRES_USER: preserve(), RAILWAY_DOCKERFILE_PATH: preserve() },
  });

  return project("saakshi", {
    resources: [web, api, minio, valkey, db, valkeyVolume, dbVolume, minioVolume],
  });
});
