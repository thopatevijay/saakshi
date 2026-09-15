# Deployment — the hosted SAAKSHI control plane

A judge gets a URL and a login. This document is how that URL exists, what is behind it, what is
**not** behind it, and how to put it back when it breaks.

Ticket: **D4-01**. Platform: **Railway**. Everything here is reproducible from a clean clone.

---

## 1 · Topology — and which one is in force

The ticket anticipated two shapes, decided by one question from Day 0:

> **D0-02 Q4 · Datacenter-IP reachability — LOW RISK, and mitigated regardless.**
> *Auth is a **session cookie**, not IP allow-listing. Cloudflare does not block datacenter ranges by
> default. Mitigated either way: Topology B runs workers locally against the cloud database.*

So the feeds are **not** the constraint. **Topology B is in force anyway**, for a different and more
honest reason:

> The analytics worker is Python 3.11 + YOLO11 + OpenCV + ByteTrack. It is not one of the five
> services D4-01 scopes, Railway offers no GPU, and a CV pipeline on a shared vCPU would produce
> measurements that misrepresent the system rather than describe it. The cloud runs the **control
> plane**; inference stays where the hardware is.

```
                    ┌──────────────────────── RAILWAY (public) ────────────────────────┐
                    │                                                                  │
  judge ──HTTPS──▶  │  web  (Next.js 15)  ──API_BASE_URL──▶  api  (Fastify, 1 replica) │
                    │   │  .next-prod                              │                   │
                    │   │  data/gujarat.pmtiles (28 MB, in-image)  │                   │
                    │   └── /basemap  Range-served, no tile CDN    │                   │
                    │                                              │                   │
                    │        ┌─────────────── private network ─────┴──────┐            │
                    │        ▼                    ▼                       ▼            │
                    │   db (timescaledb-ha)   valkey:8              minio (NO domain)   │
                    │   volume /home/…/data   volume /data          volume /data        │
                    └──────────┬───────────────────┬───────────────────────────────────┘
                               │ TLS (sslmode=require)
                    ┌──────────┴───────────────────┴──────────── LOCAL MACHINE ─────────┐
                    │  workers/analytics  (YOLO11 · ByteTrack · ONNX plate OCR)         │
                    │  workers/prober     (trust probing)                               │
                    │  npm run sync:catalogue · consume:sightings · consume:evidence    │
                    └──────────────────────────────┬───────────────────────────────────┘
                                                   │ HLS (cookie auth)
                                          government sandbox gateway
```

**Only `web` and `api` have public domains.** `db`, `valkey` and `minio` are reachable solely on the
private network — MinIO's console is not exposed at all, which is an acceptance criterion, not a
preference.

### What is deliberately *not* deployed

Four services from `docker-compose.yml` are absent, because the ticket scopes five and adding more
is scope this ticket does not own. Each degrades honestly rather than silently — that is the point:

| Absent | Consequence on the hosted instance | Honest? |
|---|---|---|
| **OSRM** | Route segments render `inferred_unroutable` with a reason; the trace itself is unaffected | Yes — the API already treats a cold road graph as a stated absence, not an error |
| **MediaMTX** | The WHEP low-latency panel is unavailable. The **HLS relay still works** — it proxies the sandbox through the API | Yes — WHEP's adapter status was already `demonstrated`, never `operational` |
| **Prometheus / Grafana** | `/metrics` is still served by the API; nothing scrapes it | Yes — the dashboard is reproducible with `docker compose up` |
| **Analytics / prober workers** | Run locally (Topology B) and write to the cloud database | Yes — this is the documented topology, not a gap |

Export bundles (`POST /api/v1/audit/export`) write to `<repo>/exports/`, which on a container
platform is **ephemeral** — a bundle survives until the container restarts. Inherited from D3-04.
If a judge must download one, D4-02 either points `exportDir` at a volume or streams it back
over HTTP.

---

## 2 · The five services

| Service | Built from | Volume (mount) | Public domain |
|---|---|---|---|
| `db` | `ops/db/Dockerfile` → `timescale/timescaledb-ha:pg16` | `/home/postgres/pgdata/data` | **no** |
| `valkey` | `ops/valkey/Dockerfile` → `valkey/valkey:8-alpine` | `/data` | **no** |
| `minio` | `ops/minio/Dockerfile` → `quay.io/minio/minio` | `/data` | **no** |
| `api` | `packages/api/Dockerfile` | — | yes |
| `web` | `packages/web/Dockerfile` | — | yes |

**Every service is built from a Dockerfile in this repository**, selected per service with the
`RAILWAY_DOCKERFILE_PATH` variable. The three datastores could have been plain image services, and
were at first — but Railway takes an image service's **start command from a dashboard field the CLI
cannot set**, and not one of the three runs correctly on its image default:

- `minio` without `server /data` prints its help text and exits;
- `valkey` without `--appendonly yes` keeps the stream in memory, so the attached volume is
  decorative and a redeploy silently starts from empty;
- `db` needs a wrapper for the volume-ownership problem described in § 2.1.

Wrapping each in a two-line Dockerfile keeps the whole deployment reproducible from a clone, with no
step that depends on someone remembering to click something.

**MinIO is pulled from quay.io, not Docker Hub.** `docker.io/minio/minio:latest` now refuses an
anonymous pull (`insufficient_scope: authorization failed`). A laptop holding a cached copy never
notices; a clean builder fails outright. `docker-compose.yml` still names the Docker Hub path and
has the same exposure — logged to `BL-01`.

### 2.1 · Why `db` needs an entrypoint wrapper

Three facts collide, and the resulting error message points at none of them:

1. **The image runs as `postgres` (uid 1000) from PID 1.** The official postgres image starts its
   entrypoint as root, prepares the data directory and drops privileges with gosu. This one never
   gets that chance.
2. **Railway chowns a volume to the container user only when it first provisions it.** Measured over
   five deploys at two different mount paths: `dir_owner=0 writable=n`, unchanged after 150 s.
   `RAILWAY_RUN_UID=0` does not override it — with that variable set the process still reported
   uid 1000.
3. **ext4 puts `lost+found` in the root of every volume**, and `initdb` refuses a non-empty
   directory. Its own hint — *"Create a subdirectory under the mount point"* — cannot be followed,
   because creating that subdirectory is blocked by (1) and (2).

`ops/db/entrypoint.sh` sets `USER root`, takes ownership of the volume, removes the one entry
`initdb` objects to, and `exec gosu postgres`es into the base image's entrypoint unchanged.
**Postgres itself never runs as root.** On the second and every later boot it finds `PG_VERSION`
and changes nothing — verified across a redeploy, with no re-`initdb`.

Railway's **managed Postgres plugin is unusable here**: it ships neither PostGIS nor TimescaleDB.
The custom image is not a preference, it is the only option — and migration `0001_extensions` says
so in its own header, creating both extensions itself because `db/init/00-extensions.sql` only ever
runs on a compose first boot.

### Start commands

`db` needs the same connection ceiling the compose stack uses. The image default is 100, which
`DATABASE_POOL_MAX=50` plus a worker plus a `psql` session exhausts — and the failure presents as
application 500s while the log says `FATAL: sorry, too many clients already`:

```
-c max_connections=300
```

`valkey`: `valkey-server --appendonly yes --requirepass "$VALKEY_PASSWORD"`
`minio`: `server /data --console-address ":9001"`

---

## 3 · Environment matrix

Nothing below is committed. Every value lives in Railway's variable store; `.env` is never copied
into an image (`.dockerignore` excludes it explicitly, because an image layer is readable by anyone
who can pull it and `docker history` outlives a later `rm`).

### `api`

| Key | Value | Why |
|---|---|---|
| `DATABASE_URL` | `postgres://saakshi:…@db.railway.internal:5432/saakshi` | private network |
| `DATABASE_POOL_MAX` | `20` | one replica; leaves headroom under `max_connections=300` for the local workers |
| `VALKEY_URL` | `redis://:…@valkey.railway.internal:6379` | private network |
| `MINIO_ENDPOINT` | `http://minio.railway.internal:9000` — the **private** host | see § 3.1. Since D4-09 the API streams crops itself, so MinIO needs no public domain at all |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Railway variables | never in the repo |
| `MINIO_BUCKET` | `saakshi-evidence` | |
| `JWT_SECRET` | a generated 48-byte secret | the code's default is a development value and **must** be overridden |
| `API_HOST` | `0.0.0.0`, or `::` on a legacy environment | see § 4 |
| `QUERY_COMPILER` | `none` (or `openai` with a key) | with `none` the console is fully functional and fully open source |
| `STREAM_RELAY_*` | defaults | `STREAM_RELAY_TIMEOUT_S=180` sits **under** Railway's 300 s edge cap — see § 5 |
| `SENTINEL_*` | set only if the hosted API should reach the sandbox directly | optional |

### 3.1 · Why `MINIO_ENDPOINT` is the private host, and crops still load

**This section described the opposite arrangement until D4-09.** The history is worth keeping,
because the constraint that forced it is easy to rediscover the hard way.

Evidence crops used to reach the browser as **presigned S3 URLs**: `services/crop-url.ts` minted one
per sighting on read and `alerts/present.ts` put it straight into an `<img src>`. **SigV4 binds the
Host header**, so the host that signs and the host the browser dials must be the same string. With
`MINIO_ENDPOINT` pointing at `minio.railway.internal`, every crop in the deployed console was a
broken image — correctly signed for a hostname no browser outside the private network can resolve.

D4-01's stopgap was to give MinIO a public domain bound to port 9000 only, and point
`MINIO_ENDPOINT` at it. That worked, and it is why this section used to open by saying the public
host "looks like a mistake and is not".

**D4-09 replaced it with the design that section already named as better:** a route handler in
`packages/web` that streams the object server-side, exactly as the video-wall stream proxy does.

| | presigned URL (until D4-09) | proxied (now) |
|---|---|---|
| MinIO public domain | required | **none** |
| what the browser loads | `https://<minio-domain>/…?X-Amz-Signature=…` | `/evidence/crop?uri=s3://…` |
| who may fetch it | anyone holding the URL, for 900 s | only a live session with `alerts:view` or `trace:run` |
| object traffic | leaves the private network | stays inside it |

The crop path is now `browser → web (session cookie) → api (bearer, role check) → MinIO`, and the
bucket is unreachable from the internet at all rather than merely unlisted.

**`presignGet` has not gone away and must not.** Export bundles embed crops as *bytes*, fetched at
build time by `export-bundle.ts`, so the audit route and `export:bundle` still receive an absolute
presigned URL signed against the private host — correct, because that code runs inside the network.
`server.ts` keeps the two presenters deliberately separate (`cropPresigner` vs `cropViewUrl`);
collapsing them degrades every bundle to `reason: 'fetch_failed'` silently, since the builder records
an omission rather than throwing.

**When redeploying onto an environment that still carries the stopgap**, set `MINIO_ENDPOINT` back to
`http://minio.railway.internal:9000` and delete MinIO's public domain. The CLI has no domain-removal
command — it needs `serviceDomainDelete` over the GraphQL API (BL-01 finding 8).

### `web`

| Key | Value | Why |
|---|---|---|
| `API_BASE_URL` | `http://api.railway.internal:4000` | **This is the key the code reads** — `packages/web/src/lib/api/client.ts`. The ticket body's `NEXT_PUBLIC_API_URL` does not exist anywhere in this codebase. The web app is a BFF: every call is server-side with an httpOnly cookie, so the API never needs to be public for the console to work |
| `PMTILES_PATH` | `/app/data/gujarat.pmtiles` | already baked into the image |
| `MEDIAMTX_WHEP_BASE` / `MEDIAMTX_HLS_BASE` | leave unset | no MediaMTX is deployed. These are dialled **by the viewer's browser**, so a `localhost` value is worse than none |
| `NODE_ENV` | `production` | set by the image; decides `.next-prod` |
| `TZ` | **do not set** | timestamps are zone-pinned in `src/lib/time.ts` (`en-GB`/`Asia/Kolkata`). A `TZ` variable neither helps nor is needed — D3-14 |

---

## 4 · Private networking

Services address each other as `<service>.railway.internal:<port>`, Wireguard-encrypted, never
leaving the project.

**The one trap.** Environments created before **16 October 2025** have an **IPv6-only** private
network; newer ones are dual-stack. A server bound to `0.0.0.0` is IPv4-only, so on a legacy
environment `api.railway.internal` resolves to an AAAA record that the socket never answers — and
the symptom is a connection *timeout*, which reads like a firewall rather than a bind address.

`API_HOST` exists for exactly this. Set `API_HOST=::` on a legacy environment; on Linux that one
socket accepts IPv4 as well. The default stays `0.0.0.0` so a laptop is unaffected.

---

## 5 · The video-wall relay and the edge timeout

D3-07 measured the sandbox gateway taking **8–49 s to return a 6 s segment**, and found that a 20 s
client timeout turned 9 completed fetches into 26 upstream attempts — the gateway's work thrown away
and requested again. A platform proxy with a 30 s or 60 s default in front of
`/api/v1/streams/:id/media` reproduces that exactly, and it presents as *"the sandbox is down"*.

**Railway does not reproduce it.** Its documented HTTP limits are:

> *"HTTP requests can run for up to 15 minutes if data keeps transferring … and are otherwise closed
> after 5 minutes with no data transferred."*

300 s of silence is six times the worst segment ever observed, and `STREAM_RELAY_TIMEOUT_S=180`
deliberately sits underneath it, so **the relay gives up before the edge does** — a timeout the
application logs and can explain, rather than a 502 it cannot.

**One API replica, and this is not about cost.** The relay cache is in-process, LRU, not shared and
not persisted. It is the pacing mechanism that makes nine wall tiles cost the department gateway one
copy of a stream instead of nine — the pacing the organisers explicitly ask clients for. A second
replica halves that benefit. `numReplicas: 1` in `packages/api/railway.json` is load-bearing.

---

## 5.1 · Config as code: `railway.json` is deprecated, `.railway/railway.ts` is not

Railway rejects config-as-code outright:

> *Config as Code (railway.json / railway.toml) is deprecated. Use Infrastructure as Code
> (`.railway/railway.ts`) instead.*

That is the API's own error. Two per-package `railway.json` files were written first and were
**never applied** — which is exactly why the migration release step silently did not exist. They have
been **deleted** rather than kept as a record: a config file the platform refuses is worse than no
config file, because it reads as configuration that is in force. **`.railway/railway.ts`** replaces
them, and the platform does read it.

It was produced with `railway config pull` against the running project rather than written from
scratch — so it describes the deployment that exists, and `railway config plan` reported *"already up
to date"* before anything was added to it. Secrets are `preserve()`: pulled without
`--include-variables`, every value stays in Railway's variable store and none is in git.

```bash
npm install railway          # the SDK the authoring file imports
railway config plan          # preview
railway config apply         # apply
```

Two things worth knowing before relying on it:

- **`railway config apply` did not commit the change here.** It returned a change-set reference and
  `plan` still showed the same diff afterwards, with the service instances unchanged
  (`healthcheckPath: null`). The settings were applied through `serviceInstanceUpdate` on the
  GraphQL API instead, and verified by reading them back. Logged to `BL-01`.
- **`preDeployCommand` is a string, not an array.** An array is rejected with
  `Error in preDeployCommand - Invalid input`.

**The migration release step now exists**, which was the one real casualty of the deprecation:

```
preDeployCommand  node packages/api/dist/db/migrate.js migrate
healthcheckPath   /health (api) · /login (web — `/` is a 307 to the login screen)
numReplicas       1
sleepApplication  false
```

Migrations therefore run once, before the new container takes traffic, and a failed migration fails
the deployment instead of leaving a half-migrated database serving requests.

## 6 · Deploy runbook

Prerequisites: `railway login`, and a Railway plan that allows volumes (Hobby or above).

```bash
# ── 1 · project and services
railway init --name saakshi
for s in db valkey minio api web; do railway add --service "$s"; done

# ── 2 · point each service at its Dockerfile
railway variable --service db     set "RAILWAY_DOCKERFILE_PATH=ops/db/Dockerfile"
railway variable --service valkey set "RAILWAY_DOCKERFILE_PATH=ops/valkey/Dockerfile"
railway variable --service minio  set "RAILWAY_DOCKERFILE_PATH=ops/minio/Dockerfile"
railway variable --service api    set "RAILWAY_DOCKERFILE_PATH=packages/api/Dockerfile"
railway variable --service web    set "RAILWAY_DOCKERFILE_PATH=packages/web/Dockerfile"

# ── 3 · volumes. NOTE: --service takes a service ID here, not a name; given a name the CLI
#        panics with `called Option::unwrap() on a None value`.
railway volume --service <db-id>     add --mount-path /home/postgres/pgdata/data
railway volume --service <valkey-id> add --mount-path /data
railway volume --service <minio-id>  add --mount-path /data

# ── 4 · secrets. Use `variable set` or `--set-from-stdin`, NEVER `add --variables`:
#        `railway add` replays its prompts to stdout, so a password passed that way is echoed
#        into the terminal (and into any transcript). One had to be rotated for exactly this.
railway variable --service db  set "POSTGRES_USER=saakshi"
railway variable --service db  set "POSTGRES_DB=saakshi"
openssl rand -hex 24 | railway variables --service db --set-from-stdin POSTGRES_PASSWORD
# …likewise VALKEY_PASSWORD, MINIO_ROOT_PASSWORD, JWT_SECRET

# ── 5 · deploy, datastores first
for s in db valkey minio api web; do railway up --service "$s" --detach --ci; done

# ── 6 · the evidence bucket, once. `mc` ships inside the MinIO image, so no extra service is
#        needed — this is the Railway equivalent of compose's `minio-init` one-shot.
railway ssh --service minio mc alias set local http://127.0.0.1:9000 saakshi "$MINIO_ROOT_PASSWORD"
railway ssh --service minio mc mb --ignore-existing local/saakshi-evidence

# ── 7 · migrations run themselves, as api's preDeployCommand (§ 5.1). To run one by hand:
railway ssh --service api node packages/api/dist/db/migrate.js migrate

# ── 8 · public domains for api and web ONLY.
#        `railway domain` CREATES a domain when none exists rather than merely reporting one, so
#        running it "just to look" against minio publishes it. If that happens, delete it:
#        serviceDomainDelete over the GraphQL API — the CLI has no removal command.
railway domain --service api --port 8080
railway domain --service web --port 8080
```

### A trap in `railway ssh`

It re-joins its arguments through a remote shell **without quoting them**, so any argument
containing a space or a parenthesis is mangled before it arrives:

```
$ railway ssh --service api psql "$URL" -c "select postgis_version();"
sh: 1: Syntax error: "(" unexpected
```

Commands whose arguments are individually space-free work fine. For anything else, put it in a file
the image already carries — which is why `db/checks/deployment.sql` exists and is run with `-f`.

### Loading the estate (Topology B, from the local machine)

The registry is populated from the sandbox catalogue, not from a fixture. `sslmode=require` is not
optional — this is a police estate crossing the public internet:

```bash
export DATABASE_URL='postgres://saakshi:…@<db-public-host>:<port>/saakshi?sslmode=require'
npm run sync:catalogue -- --source "$SENTINEL_INGEST_URL"
npm run seed:watchlist
npm run consume:sightings        # long-running; writes sightings as the workers produce them
```

Confirm the connection really was encrypted, rather than assuming it:

```sql
select ssl, version from pg_stat_ssl join pg_stat_activity using (pid) where pid = pg_backend_pid();
```

### Credentials

`0009_seed` creates four users whose password is the published development value `saakshi-dev`, and
its own header says *"D4-01 must not deploy these rows"*. The migration runner cannot skip one file,
so the rows arrive — and are then **rotated** on the deployed database to a value that exists only
in Railway's variable store and in the gitignored `.dev-refs.md`:

```sql
update users set password_hash = crypt(:'newpw', gen_salt('bf')) where badge_no = :'badge';
```

D4-02 issues the judge-facing credentials proper.

---

## 7 · Verification — measured, 2026-09-13

The deployed URLs are in the gitignored `.dev-refs.md`, and on the D4-01 issue.

```bash
curl -fsS  https://<api-domain>/health
curl -fsSI https://<web-domain>/login | head -1
railway ssh --service api psql "$DATABASE_URL" -P pager=off -f /app/db/checks/deployment.sql
curl -fsSI https://<minio-domain> || echo "minio correctly not public"
```

What that returned:

| Check | Result |
|---|---|
| api `/health` | `{"status":"ok","service":"saakshi-api","version":"0.1.0","uptimeS":1669}` |
| web `/login` | `HTTP/2 200`; `/` → 307 to the login screen |
| PostGIS | **3.6.4** — `3.6 USE_GEOS=1 USE_PROJ=1 USE_STATS=1` |
| TimescaleDB | **2.30.0**, hypertables `camera_health_checks` and `sightings` |
| Migrations | 20 of 20 applied |
| Registry | 5 departments, 4 users, **0 cameras** (see § 7.1) |
| MinIO | no public domain; the generated hostname 404s at the edge |
| Basemap | `/basemap/gujarat.pmtiles` → `HTTP/2 206`, `content-range: bytes 0-16383/29690528` |
| Console routes | `/login` `/registry` `/alerts` `/trace` all 200 with a session cookie |
| Persistence | db and valkey redeployed; 20 migrations and every seed row intact, no re-`initdb`, Valkey's `appendonlydir` preserved |
| Response time | api `/health` 1.08–1.25 s · web `/login` 1.15–1.20 s |

**Latency is geography, not the application.** TTFB is 1.10 s, of which ~0.50 s is TCP + TLS
handshaking. The project already runs in **`asia-southeast1-eqsg3a` (Singapore)** — confirmed from
the imported infrastructure graph, which is the nearest Railway region to Gujarat, so there is no
region change worth making. `uptimeS 1669` on a cold request shows the container is warm: a judge
meets a running app, not a boot screen.

### 7.1 · The registry is empty, and that is not a deployment fault

`cameras = 0` because `SENTINEL_INGEST_URL` / `SENTINEL_PORTAL_COOKIE` are not set on the `api`
service, so nothing has synced the upstream catalogue yet. The consequence is visible: **the
registry map renders its basemap and no pins.** Model 1's compulsory deliverable is therefore only
half-demonstrated on the hosted instance until the estate is loaded, by either:

```bash
# from the cloud, once the sandbox variables are set on the api service
railway ssh --service api node packages/api/dist/jobs/catalogue-sync-cli.js

# or from a local machine (Topology B), which needs a TCP proxy on the db service
DATABASE_URL='postgres://…?sslmode=require' npm run sync:catalogue
```

Do not claim a working map before this is done — see the claims discipline in `CLAUDE.md`.

**Never verify the map through a backgrounded browser tab.** Chrome suspends `requestAnimationFrame`
entirely when `visibilityState` is `hidden` — measured **0 callbacks in 18.4 s** where ~1,100 were
due — and MapLibre runs its whole render pipeline off rAF. The map constructs, emits no events and
draws no tiles: indistinguishable from a broken deploy. Use `packages/web/scripts/cdp.mjs`, which
launches its own Chrome with an explicit window size (D3-13).

A `/trace` or `/registry` page that paints and then freezes for about a second is a **hydration
failure**, not a network fault. Check the browser console for `Hydration failed` before suspecting
the server — it logs nothing server-side (D3-14).

## 8 · Redeploy, rollback, recovery

| Situation | Action |
|---|---|
| Ship a code change | `git push` (or `railway up --service <s>`). `watchPatterns` in each `railway.json` keeps an API change from rebuilding the web image |
| A deploy is bad | `railway redeploy --service <s>` against the previous deployment, or **Rollback** on that deployment in the UI. Volumes are untouched |
| A migration is bad | `railway run --service api -- node packages/api/dist/db/migrate.js rollback` — one step; every migration in this repo has a tested `.down.sql`, which is why `drizzle-kit migrate` was rejected in D1-01 |
| Health check failing | `railway logs --service api`. A `invalid environment configuration: <fields>` line names the missing keys and never their values |
| Map is blank | Confirm `.next-prod` is in the image (`ls /app/packages/web/.next-prod`). A build that copies `.next` ships an empty directory and the failure is silent — D3-13 |
| Database restore | The volume is the database. Take `pg_dump` before anything destructive; Railway volume snapshots are not a substitute for a dump you have tested |

**Never `ALTER TABLE audit_log DISABLE TRIGGER` in a deploy or migration script.** With
`UNIQUE (prev_hash)` serialising audit writers, its `ShareRowExclusiveLock` deadlocks against
concurrent inserts — measured: 19 unrelated tests failing with `40P01`. Use
`SET LOCAL session_replication_role = 'replica'` inside a transaction (D3-04).

A database migrated from empty needs **no** `npm run audit:verify -- --seal`. There is no
pre-canonical prologue to seal, and `audit:verify` passes reporting `pre-canonical 0` (D3-04).

---

## 9 · Images

Both images take the **repo root** as build context — one lockfile, three workspaces.

```bash
docker build -f packages/api/Dockerfile -t saakshi-api .     # 545 MB
docker build -f packages/web/Dockerfile -t saakshi-web .     # 1.38 GB
```

Four things that cost time once and should not cost it twice:

1. **`npm ci --omit=dev` at a workspace root installs every workspace's production tree.** The API
   image carried Next, React and MapLibre — 1.24 GB before the `--workspace` filter, 545 MB after.
   Image size is cold-start time on a platform that pulls before it starts.
2. **`config/` is read at import time**, not lazily: `services/trust.ts` reads
   `config/trust-weights.json` as a module side effect, so an image without it exits before it ever
   listens.
3. **`packages/web` typechecks `scripts/generate-api-types.mts`**, which imports the API's sources to
   boot the real server and emit its OpenAPI document. The web builder therefore needs
   `packages/api` present, or `next build` fails on `Cannot find module '../../api/src/server.js'`.
4. **`next` hoists to `/app/node_modules/.bin`.** The runner's working directory is
   `/app/packages/web`, so a relative `node_modules/.bin/next` does not exist.

### The basemap is built, not copied

`data/gujarat.pmtiles` (28 MB) is gitignored build output, so the web image builds it in its own
stage with `scripts/build-basemap.sh`. A Railway build starts from a git clone and would otherwise
ship a console with no map.

It is **deliberately unpinned**, which inverts the usual rule. Protomaps retains its daily planet
builds for about **six days** — measured 2026-09-13: `20260908.pmtiles` answers `206`,
`20260906.pmtiles` answers `404`. A date baked into the Dockerfile is therefore guaranteed to break
the *image build* within a week, for a reason unrelated to the deploy. Pin one inside the window
with `--build-arg PROTOMAPS_BUILD=YYYYMMDD` when reproducing a specific extract;
`/app/data/basemap-build.txt` in the image records which one shipped, with its OSM replication
timestamp.

---

## 9.1 · The Cloudflare Tunnel fallback (D4-02)

Railway hosts the **control plane**. Two things are not on it and may never be: the analytics and
prober workers (Python + YOLO11, and this platform has no GPU), and MediaMTX, without which the WHEP
low-latency panel cannot be shown. If a live-feed demonstration has to be given — or if Railway is
unreachable from the demonstration room — a tunnel exposes the **local** stack, feeds and all, with
no data migration and no second deployment to keep in sync.

```bash
# one binary, no account, no DNS
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz \
  | tar -xz && chmod +x cloudflared

npm start                                    # API :4000, console :3000, compose services up
./cloudflared tunnel --url http://localhost:3000 --no-autoupdate
```

It prints a `https://<random>.trycloudflare.com` URL. That is the whole setup.

**Tested end to end, 2026-09-14**, against a local stack:

| Check | Result |
|---|---|
| `GET /` | `307` → the login screen, in 0.94 s |
| `GET /login` | `200`, 0.42 s |
| `GET /registry` with a session | `200` — a real screen, not just the shell |
| `GET /basemap/gujarat.pmtiles` with `Range` | `HTTP/2 206`, `content-range: bytes 0-8191/29781693` |

That last row is the one worth checking, because it is the one that breaks silently: PMTiles is read
in byte ranges, so a tunnel or proxy that does not pass `Range` through makes the browser pull 28 MB
to draw a single tile, and the map appears to hang rather than to fail.

**Two caveats.** A quick tunnel's hostname is random and changes on every restart, so it is a
demonstration tool, not a submission URL — the Railway deployment is what goes on the form. And the
console is then only up while the laptop is: `npm start` and `cloudflared` both have to stay running.

## 11 · Production parity — what must be true of a deployed environment (D4-13)

**The deployed URL is what gets judged.** On 15 Sep an every-table audit found the deployed database
was not the system a laptop runs: a *compulsory* deliverable and two differentiators returned zeros
there while passing locally. None of it showed up in a health check, because every service was up —
the data and one whole service were missing, not broken.

A feature that works locally and returns zeros on the deployed URL is a feature we do not have. Each
row below is a thing that was actually wrong, with the command that proves it is not wrong now.

| Must be true | Proof | What it was on 15 Sep |
|---|---|---|
| The road graph is loaded | `select count(*) from road_network` → **540,711** | **0** — gap analysis, Model 1's compulsory GIS deliverable, could not run |
| Coverage reproduces the published figures | `DATABASE_URL=… npm run report:gap-analysis` → 21.4712 / 0.0000 km, 6,750 of 6,750 junctions | could not run at all |
| An OSRM service exists and `api` can reach it | trace response `route.roadGraph.baseUrl` is `http://osrm.railway.internal:5000` | no `osrm` service existed; `OSRM_URL` fell back to `http://localhost:5000` **inside the container** |
| Routes actually measure | `select count(*) from route_segments where road_distance_m is not null` → non-zero | **0 of 40**, so every trace reported `0.0 km observed` |
| The ingest run matches the artefacts | per-camera counts in the report window: `cam01` 2,674 · `cam04` 7,634 · `cam05` 4,592 | **4 sightings total** |
| No service resolves a dependency to localhost | `railway variables --service <s> --kv \| grep -E '_(URL\|ENDPOINT\|HOST)=' \| grep -c localhost` → 0 everywhere | `api` had one |
| Evidence crops load | `npm run check:links -- --base <web> --api <api>` → 0 broken | passed, but only after D4-09's proxy fix reached the deployment |

### Three traps this cost a day to find

**1 · A Railway variable change does not restart the service.** After `railway variables --set`, the
API's `/health` still reported `uptimeS: 6032` — the same process, holding the old value. Every
health check stayed green while the running code dialled a hostname that no longer existed. Always
`railway redeploy --service <s>` afterwards, and confirm `uptimeS` actually reset before believing
anything.

**2 · A PG 17 `pg_dump` into a PG 16 server writes nothing and looks fine.** Homebrew ships 17; the
server is `timescaledb-ha:pg16`. The dump preamble emits `SET transaction_timeout = 0`, PG 16 rejects
it, and with `ON_ERROR_STOP=1` the load aborts having written **0 rows** while every surrounding
command reports success. Use `\copy … to stdout | \copy … from stdin` with explicit column lists:
no preamble, no version coupling. 540,711 rows in **43 s** that way, indexes dropped first.

**3 · A cache cannot invalidate on an input it cannot see.** The route cache keys on the question and
fingerprints the sightings — but the **road graph is a third input, and it lives outside the
database**. Loading the graph and deploying OSRM changed neither key, so every cached route stayed a
hit and kept serving `0.0 km observed` from a build made when no router existed. `?refresh=true` on
the trace endpoint is the escape hatch; there is no fingerprint that could have caught this.

### Promoting an ingest run between environments

`pg_dump` **cannot** do this. The two databases generated different uuids for the same camera —
`cam04` is `af0eb90e…` locally and `cb0ffcf7…` deployed — so a straight copy either violates the
foreign key or attaches sightings to the wrong camera. Use the script, which remaps `camera_id` by
`external_id` while preserving sighting and plate-read ids, because
`submission/govt-feed-output-report.csv` cites each `plate_read_id`:

```bash
npm run db:promote-run -- --from "$LOCAL_URL" --to "$PROD_URL" \
  --window 2026-09-11T00:00:00Z..2026-09-12T00:00:00Z --dry-run
```

`sightings` is a TimescaleDB hypertable, so its primary key is `(id, ts)` and `ON CONFLICT (id)`
fails outright. The script handles that; a hand-written insert will not.

### Why a report regenerated against the wrong environment is worse than no report

Regenerating `govt-feed-output-report` against the deployed database *before* the run was promoted
produced a report that was internally consistent and quietly **dropped the line disclosing that
cam01 saw 2,674 vehicles and read zero plates** — because in that environment cam01 had no sightings
at all. The figures were all true. The disclosure that makes the report honest was gone. Regenerate
deliverables only against an environment that has passed the table above.

## 10 · A note on `PROJECT.md`

`PROJECT.md` § *Third-party services / spend* still records **Cloudflare Tunnel** as the public-demo
decision, from before Day 4 was planned. D4-01 supersedes it with Railway; the tunnel remains the
documented fallback and is D4-02's scope. Logged to `BL-01`.
