# SAAKSHI — project instructions

**Not a Solana project.** Ignore any inherited Anchor/Rust/Pinocchio/.NET guidance — there is no
blockchain, no on-chain program, and no `cargo`/`anchor` in this repo.

AI-powered CCTV integration and video analytics for the **Gujarat Police Innovation Challenge 2026**
(portal: sentinel.gujarat.gov.in). Node/TypeScript + Python + Postgres/PostGIS + computer vision.

## Read these before acting

| File | What it holds |
|---|---|
| `PROJECT.md` | Architecture, locked decisions, pillars, tech stack, sizing — **the spec** |
| `WORKFLOW.md` | How work gets done; the session-independence contract |
| `.github/plan/*.md` | All 44 tickets (AC, deliverables, validation gates) |
| `.github/plan/issue-map.json` | Ticket id → GitHub issue number |

**Deadline: 7 September 2026, submit by midday.** Repo: `thopatevijay/saakshi`.

## How to work

Never freelance. Every change belongs to a ticket:

```
/status                →  what is next, rebuilt from GitHub with zero context
/start <TICKET-ID>     →  branch · PRP · implement · verify each AC · gate · PR · merge · close
/gate <GATE-ID>        →  verify a whole day from a clean state
/backlog "<finding>"   →  log a bug/gap/pitfall to BL-01 without derailing the ticket in flight
```

The GitHub issue is the specification. Do not add or drop scope. An AC passes only with **evidence** —
command output, a test name, a file, a row count. Never "looks right".

Out-of-scope discoveries go to `/backlog`, never fixed inline.

## Stack

TypeScript strict (Fastify API, Next.js 15 web, shared zod types) · Python 3.11 workers
(OpenCV, YOLO11, ByteTrack, ONNX plate OCR) · PostgreSQL 16 + PostGIS + TimescaleDB · Valkey Streams ·
MinIO · MediaMTX · OSRM · MapLibre + self-hosted PMTiles. **npm**, not yarn.

All open source — the challenge's About page states solutions *should* use open-source technologies.
The only proprietary dependency is the optional NL-query LLM, and it sits behind a `QueryCompiler`
interface with four providers (`openai` primary · `anthropic` · `ollama` local · `none`). Nothing
proprietary is load-bearing: with `ollama` or `none` the system is fully functional and fully open.

## Domain rules that are easy to get wrong

- **Timing comes from PTS, never frame arrival time.** The sandbox gateway replays a buffered GOP on
  connect, so an arrival-time tracker computes impossible velocities after every reconnect.
- **Never trust declared FPS** (`CAP_PROP_FPS`). Measure it. The declared-vs-measured delta is a
  product feature, not a bug.
- **Force RTSP over TCP** (`rtsp_transport=tcp`); fall back to HLS if 8554 is blocked.
- `GET /api/ingest` is **the contract**; the stream URL pattern is not. Never hardcode endpoints.
- Feeds loop — a hard scene cut is normal. Track IDs and galleries must reset, not bleed across it.
- Join-time decoder warnings are logged, never fatal. Reconnect with 2s→30s backoff, never tight loops.
- Consume only. Never publish to the gateway or call its control API.

## Claims discipline — this is scored

- **No live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity.** Connectors are *specified*, with a
  mock provider. Never imply otherwise.
- **No face recognition.** Deliberately out of scope; not mandated, and it needs separate legal
  authorisation. We process no biometrics.
- **No accuracy claims without measurement.** Report real precision/recall including where it fails
  (night, two-wheelers, oblique angles). Honest numbers are a scoring asset.
- ANPR is the **only** mandatory analytic. Everything else is bonus.

## Never

- Commit `.env`, `.dev-refs.md`, `.prp/`, `recon-out/`, model weights, or any secret
- Add a Claude co-author or "generated with" trailer to a commit (conventional messages, small and frequent)
- Pass a gate on code that looks correct — gates are empirical and run from a clean state
- Leave a ticket silently half-done — use `/start`'s Phase 8-BLOCKED
