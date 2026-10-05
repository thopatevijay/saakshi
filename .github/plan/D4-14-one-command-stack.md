---
title: "D4-14 · `npm start` starts the whole system, and `npm stop` stops all of it"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "infra", "demo-critical"]
blocked_by: []
estimate: "2h"
---

## Context

On 5 Oct 2026, a cold-start run of the full system hit three pitfalls before a single plate reached
the console:

1. **`npm start` starts half the system.** It brings up the containers, the API and the web, but
   none of the three processes that turn video into alerts: the sightings consumer, the evidence
   consumer and the analytics worker. The console comes up looking healthy and never receives
   anything live.
2. **ANPR and evidence are opt-in worker flags.** A worker started without `--anpr --evidence`
   produces 72,579 sightings and **zero plate reads**, with nothing to say why.
3. **Every API CLI loads the wrong `.env`.** `import 'dotenv/config'` resolves `.env` from the
   working directory, and npm workspaces run scripts from `packages/api/`. So
   `npm run consume:evidence` from the repo root exits with *"MINIO_ACCESS_KEY / MINIO_SECRET_KEY
   are not set"* even though the root `.env` sets both. It affects 13 entrypoints.

A live demonstration has to come up from one command, on an unfamiliar network, run by one person.

## Scope

### 1 · `npm start` = the whole system

After the API and web, `scripts/start.sh` also starts:

| Process | Command | Ready when |
|---|---|---|
| sightings consumer | `npm run consume:sightings` | log shows `consuming sightings as group` |
| evidence consumer | `npm run consume:evidence` | log shows `consuming evidence as group` |
| analytics worker | `.venv/bin/python -m workers.analytics.run … --anpr --evidence --minutes 0` | log shows `cameras connected` |

- Each gets a pidfile and a log in `.run/`, like the API and web, and is idempotent: one already
  running is left alone.
- The worker's scope comes from `SAAKSHI_WORKER_CAMERAS` (default `cam04 cam05`, the two sandbox
  cameras measured producing frames) and/or `SAAKSHI_WORKER_SOURCES` (`id=url`, space-separated, for
  a feed that is not in the registry, such as a venue camera or a phone over RTSP).
- **The worker is optional; the core stack is not.** No `.venv`, or `npm start -- --no-worker`,
  means a warning and a skip, never a failed start. A judge cloning the repo without Python still
  gets a working console.
- The banner lists all five host processes and their logs.

### 2 · `--minutes 0` runs the worker until it is stopped

Today the worker always ends after `--minutes` (default 5). `0` means no deadline. SIGTERM and SIGINT
set the stop event, so the run ends cleanly and still prints its summary, instead of being killed
mid-frame.

### 3 · `npm run stop` stops everything `start` started

Stops the worker and both consumers (by pidfile, then by process pattern, as it already does for the
API and web), then the API and web, then the containers. Volumes are still preserved unless
`--purge` is passed.

### 4 · One `.env` loader for every API entrypoint

A single module resolves the **repository root** `.env`. Every `import 'dotenv/config'` in
`packages/api/src` and `scripts/` uses it. A missing file is still a no-op, which Railway relies on.

### Out of scope

Running the worker on Railway, and GPU or CUDA selection.

## Acceptance Criteria

- [ ] From a fully stopped state, `npm start` brings up containers, API, web, both consumers and the
      worker. **Evidence:** `ps` shows all five host processes, and new `sightings` rows land within
      2 minutes with nothing else run by hand
- [ ] With the default scope, a `plate_reads` row or an `anpr` log line proves ANPR ran without
      passing any flag by hand
- [ ] `npm start` run a second time is a no-op for every running process (no duplicate consumers)
- [ ] `npm start -- --no-worker`, and a start with `.venv` absent, both still finish with the API and
      web up and print why the worker was skipped
- [ ] `npm run stop` leaves no SAAKSHI host process (`pgrep` empty for api, web, consumers and worker)
      and no running containers; the volumes still exist
- [ ] `npm run consume:evidence` run from the repo root, **without** sourcing `.env` by hand, starts
      consuming
- [ ] `--minutes 0` plus SIGTERM ends the worker with exit code 0 and a printed summary; covered by a
      Python test
- [ ] `npm run typecheck && npm run lint` green; the Python worker tests green
- [ ] README Quickstart and `.env.example` describe the new behaviour and variables

## Deliverables

- `scripts/start.sh`, `scripts/stop.sh`
- `workers/analytics/run.py` (`--minutes 0`, signal handling) and a test
- `packages/api/src/load-env.ts` (or equivalent), used by every entrypoint
- `README.md` § Run it, `.env.example`

## Validation Gate

```bash
npm run stop && npm start
pgrep -fl 'consume:sightings|consume:evidence|workers.analytics.run|packages/api/src/index.ts|next dev'
sleep 120; psql "$DATABASE_URL" -tAc "select count(*) from sightings where ingested_at > now() - interval '3 min'"
npm start                        # second run: every process "already running"
npm run stop; pgrep -fl 'consume:|workers.analytics.run' || echo "clean"
npm run typecheck && npm run lint && ./.venv/bin/python -m pytest workers/analytics/tests -q
```
