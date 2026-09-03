---
title: "D4-01 · Deploy to Railway: API, web, Postgres/PostGIS/Timescale, Valkey, MinIO"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "infra", "deploy"]
blocked_by: ["D3-GATE"]
estimate: "3h"
---

## Context

Submissions may include *"a URL to their hosted platform along with test login credentials for the
screening committee"*. A live URL a judge can click is worth more than any screenshot.

**Critical constraint discovered in D0-02 Q4:** if the sandbox RTSP endpoints are unreachable from a
datacenter IP, the ingest workers **cannot** run on Railway. In that case the topology is split:
control plane in the cloud, ingest on a local machine writing to the cloud database. Decide from the
D0-02 answer, and document whichever applies.

## Scope

**Topology A — feeds reachable from cloud:** everything on Railway.
**Topology B — feeds blocked from cloud (expected):** Railway hosts `db`, `valkey`, `minio`, `api`,
`web`; workers run locally against the Railway `DATABASE_URL` / `VALKEY_URL` over TLS.

Services:
- `db`: **custom image** `timescale/timescaledb-ha:pg16` with a persistent volume — Railway's managed
  Postgres does **not** include TimescaleDB or PostGIS, so the managed plugin is not usable
- `valkey`: `valkey/valkey:8` with a volume
- `minio`: `minio/minio` with a volume, console **not** publicly exposed
- `api`: Dockerfile build, health check, autoscale off (single instance is fine)
- `web`: Next.js, `NEXT_PUBLIC_API_URL` → the API service
- Private networking between services; only `web` and `api` get public domains
- Secrets via Railway variables; nothing in the repo
- Migrations run as a release step, not on boot race

## Acceptance Criteria

- [ ] All five services deploy and stay healthy
- [ ] `db` confirmed to have **both** PostGIS and TimescaleDB (`select postgis_version()`,
      `select extversion from pg_extension where extname='timescaledb'`)
- [ ] Volumes attached and persistence proven across a redeploy (data survives)
- [ ] Migrations applied on the deployed database
- [ ] `web` loads over HTTPS; login works; registry map renders with real data
- [ ] MinIO console **not** publicly reachable; signed URLs still work from the web app
- [ ] Chosen topology (A or B) documented, with the reason from D0-02 Q4
- [ ] Under Topology B: local workers verified writing to the Railway database over TLS
- [ ] Cold-start time recorded; a judge clicking the URL sees a working app, not a boot screen
- [ ] Zero secrets committed (`git grep` for the key patterns comes back clean)

## Deliverables

- `railway.json` / service configs, `Dockerfile` for api and web
- `docs/deployment.md` — topology diagram, env matrix, redeploy runbook, rollback steps
- Deployed URLs recorded in `.dev-refs.md` and as a comment on this issue

## Validation Gate

```bash
railway status
curl -fsS https://<api-domain>/health
curl -fsSI https://<web-domain> | head -1
railway run psql $DATABASE_URL -c "select postgis_version(); select extversion from pg_extension where extname='timescaledb';"
railway run psql $DATABASE_URL -c "select count(*) from cameras;"
curl -fsSI https://<minio-domain> || echo "minio correctly not public"
git grep -nE "(sk-ant|AKIA|BEGIN (RSA|OPENSSH) PRIVATE)" -- . && echo "SECRET LEAK" || echo "no secrets"
```

- [ ] Health checks green; extensions present; camera count non-zero
- [ ] Redeploy persistence test passes
- [ ] No secrets in the repo

## Handoff → D4-02, D4-07

Publish the final public URLs as a comment; the README and submission form both need them.
