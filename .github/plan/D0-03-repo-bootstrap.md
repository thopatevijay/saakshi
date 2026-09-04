---
title: "D0-03 · Repo bootstrap: workspaces, tooling, compose stack up"
milestone: "Day 0 — Recon & Bootstrap"
labels: ["day-0", "infra"]
blocked_by: []
estimate: "2h"
---

## Context

Everything after this ticket assumes `docker compose up` gives a working data plane and that
`npm run dev` starts API + web. Get it right once.

## Scope

- npm workspaces monorepo: `packages/api`, `packages/web`, `packages/shared`
- TypeScript strict everywhere; shared `tsconfig.base.json`; no `@ts-ignore`
- ESLint + Prettier; `npm run lint`, `npm run typecheck`, `npm run test` at root
- Python workspace: `workers/` with `requirements.txt` and a **`.venv` convention (mandatory)**

  > Learned the hard way on 2026-09-04: Homebrew's default `python3` here is **3.14 and
  > PEP-668 externally-managed** — `pip install` fails outright, and `pip` is not even on PATH
  > (use `python3 -m pip`). OpenCV wheels for 3.14 are not reliable. A **`.venv` built on
  > python3.13 already exists** with `opencv-python` 5.0 and `requests` installed. Use
  > `./.venv/bin/python` everywhere; never the system interpreter.
- Verify the compose stack: db (Postgres 16 + PostGIS + Timescale), valkey, minio, mediamtx
- `packages/shared`: zod schemas + TS types shared by API and web
- Root `Makefile` (or npm scripts) for the common loops
- `.env` created from `.env.example` and populated with recon findings

## Out of scope

- Migrations (D1-01), any feature code

## Acceptance Criteria

- [ ] `docker compose up -d` brings db, valkey, minio, mediamtx to healthy
- [ ] `psql $DATABASE_URL -c "select postgis_version(); select extversion from pg_extension where extname='timescaledb';"` returns both
- [ ] MinIO console reachable at :9001 and the `saakshi-evidence` bucket exists
- [ ] `npm install` at root resolves all three workspaces
- [ ] `npm run typecheck` and `npm run lint` pass clean (zero warnings)
- [ ] `npm run dev` starts API on :4000 (`GET /health` → 200) and web on :3000
- [ ] Python: `./.venv/bin/python -m pip install -r workers/requirements.txt` succeeds and
      `./.venv/bin/python -c "import cv2, ultralytics"` works
- [ ] `ffmpeg` and `ffprobe` present on PATH and documented as prerequisites — the HLS adapter and
      the recon tooling both depend on them (ffmpeg 8.0.1 confirmed working on this machine)
- [ ] README states the venv requirement explicitly, including the PEP-668 trap
- [ ] `.env` present and gitignored; `.env.example` committed and in sync

## Deliverables

- Working monorepo skeleton
- `README.md` stub with a real "how to run" section
- `packages/shared` exporting at least `CameraConfig`, `Sighting`, `Alert` types

## Validation Gate

```bash
docker compose ps            # all healthy
npm run typecheck && npm run lint
curl -fsS localhost:4000/health
curl -fsSI localhost:3000 | head -1
./.venv/bin/python -c "import cv2, ultralytics; print('cv ok')"
ffmpeg -version | head -1
```

- [ ] All five commands succeed from a clean clone + `docker compose up`
- [ ] Documented in README so a judge can reproduce it

## Handoff → D1-01

Confirm the exact Postgres extension versions available; the migration must target them.
