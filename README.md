# SAAKSHI — साक्षी, "the witness"

CCTV registry, federation fabric and video analytics for the **Gujarat Police Innovation Challenge
2026**. Reference **Model 1** (registry / onboarding) + **Model 4** (integration depth).

Architecture, locked decisions and sizing: [`PROJECT.md`](PROJECT.md).
How work gets done: [`WORKFLOW.md`](WORKFLOW.md). All 44 tickets: [`.github/plan/`](.github/plan).

> **Scope honesty.** No live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity — those
> connectors are *specified* and served by a mock provider. **No face recognition**: deliberately
> out of scope, no biometrics are processed. Accuracy figures are measured and reported with their
> failure cases, never asserted.

---

## Prerequisites

| Tool | Version used | Why |
|---|---|---|
| **Node** | ≥ 22 (built on 24.12.0) | API + web workspaces |
| **npm** | ≥ 10 | Package manager — **not** yarn |
| **Docker** + Compose v2 | 29.1.3 / v2.40.3 | The whole data plane |
| **Python** | **3.13** via the repo-local `.venv` (see below) | CV workers |
| **ffmpeg / ffprobe** | **8.0.1** | **Mandatory.** The HLS adapter and `scripts/recon.py` both shell out to them — nothing that touches a feed works without them |
| **psql** | 16 client | Verifying and querying the database |

```bash
# macOS
brew install node docker ffmpeg libpq
```

`ffmpeg` and `ffprobe` must both be on `PATH`:

```bash
ffmpeg -version | head -1
ffprobe -version | head -1
```

---

## How to run

```bash
git clone https://github.com/thopatevijay/saakshi.git && cd saakshi

cp .env.example .env          # then fill in the Sentinel sandbox values
make up                       # db · valkey · minio · mediamtx, waits for healthy
make install                  # creates .venv if missing, then npm workspaces + Python deps
make migrate                  # schema + seed (5 departments, 4 users)
make dev                      # API on :4000, web on :3000
```

`make install` creates `.venv` on **python3.13** when it does not exist — the venv is gitignored, so
a fresh clone has none. `make dev` builds `@saakshi/shared` before starting either server; without
that step `packages/web` cannot resolve the workspace package and returns HTTP 500.
**`make migrate` is not optional**: the test suite asserts the live schema, so it fails on a
reachable-but-empty database.

Verify:

```bash
make ps                                   # four containers, all (healthy)
make db-status                            # nine migrations, all applied
curl -fsS localhost:4000/health           # {"status":"ok","service":"saakshi-api",...}
curl -fsSI localhost:3000 | head -1       # HTTP/1.1 200 OK
make verify                               # typecheck + lint + test
```

`make help` lists every target.

### Database

Schema, ER diagram and the reasoning behind the three non-obvious decisions:
[`docs/data-model.md`](docs/data-model.md).

| | |
|---|---|
| `make migrate` | apply pending migrations (idempotent) |
| `make rollback` | revert the newest migration · `ROLLBACK_ALL=1 make rollback` reverts all |
| `make db-reset` | drop and recreate `public`, then migrate — **destroys all data** |
| `make db-status` | applied vs pending |

Migrations are paired `db/migrations/NNNN_name.{up,down}.sql`, each applied in one transaction with
its checksum recorded. Editing an already-applied migration fails loudly rather than leaving two
databases at the same version with different shapes.

Seed logins are **development only** — all four users have the password `saakshi-dev`. They are not
deployed; judge credentials are issued separately (D4-02).

### Services

| Service | Host port | Notes |
|---|---|---|
| PostgreSQL 16 + PostGIS 3.6 + TimescaleDB 2.29 | 5432 | `timescale/timescaledb-ha:pg16`. Extensions created by `db/init/00-extensions.sql` on first init |
| Valkey 8 | 6379 | Event bus (Streams) |
| MinIO | 9000 (API) · 9001 (console) | Bucket `saakshi-evidence` created by the `minio-init` one-shot |
| MediaMTX | 8554 RTSP · 8888 HLS · 8889 WHEP · 9998 metrics | Our own gateway for the video wall |
| OSRM | 5000 | **Opt-in**: `docker compose --profile routing up -d osrm`. Needs the Gujarat extract prepared first — see the comment in `docker-compose.yml` |

If port 5432 is already taken by another project's container, stop it (`docker stop <name>`) rather
than remapping — every ticket and `.env.example` assume the standard port.

---

## Python workers — read this before touching `workers/`

**Always use the repo-local interpreter: `./.venv/bin/python`. Never the system `python3`.**

```bash
./.venv/bin/python -m pip install -r workers/requirements.txt
./.venv/bin/python -c "import cv2, ultralytics; print('cv ok')"
```

Why this is not optional, learned the hard way on 2026-09-04:

- Homebrew's default `python3` on this machine is **3.14** and **PEP 668 externally-managed**.
  `pip install` fails outright with `error: externally-managed-environment` — it will not install
  into it, and no flag you want to be using changes that.
- `pip` is **not on `PATH`** at all. Use `python3 -m pip`, never bare `pip`.
- **OpenCV wheels for 3.14 are not reliably published.** The venv is built on **python3.13**
  precisely so `opencv-python` and `ultralytics` resolve to real wheels instead of a source build.

Recreating it from scratch:

```bash
python3.13 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r workers/requirements.txt
```

`.venv/` is gitignored. `make venv` prints the interpreter and the installed CV versions.

---

## Layout

```
packages/shared     zod schemas + TS types shared by API and web (CameraConfig, Sighting, Alert)
packages/api        Fastify + TypeScript strict — the API surface
packages/web        Next.js 15 + React 19 + Tailwind — the operator UI
workers/            Python CV workers (prober, analytics)
db/init/            extensions, run once on an empty data directory
db/migrations/      schema (D1-01)
scripts/            recon and repo tooling
docs/               architecture and official documents
```

TypeScript is **strict everywhere and `@ts-ignore` is banned**; `npm run lint` runs with
`--max-warnings 0`.

## Configuration

`.env.example` is the committed contract and lists every key the code reads. Copy it to `.env` and
fill it in. **`.env` is never committed** and secrets are never printed — see the strict rule in
[`CLAUDE.md`](CLAUDE.md).

## Licence

MIT. Every runtime dependency is open source; the optional NL-query LLM sits behind a
`QueryCompiler` interface with a local (`ollama`) and a disabled (`none`) provider, so nothing
proprietary is load-bearing.
