---
title: "D4-15 · `npm start` mistakes another app on :3000 for SAAKSHI and never starts the console"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "infra", "demo-critical", "bug"]
blocked_by: []
estimate: "1h"
---

## Context

`scripts/start.sh` decides the web console is "already running" if `curl localhost:3000/login`
returns 200. Any app on :3000 with a `/login` page passes that check. On 5 Oct 2026 another project's
container held :3000, so `npm start` printed `✓ web already running on :3000` and a banner pointing
at :3000, but SAAKSHI's web had never started. The browser showed the other app's login page. The API
check (`curl :4000/health`) has the same weakness. BL-01 finding 3 (D4-14).

A demo laptop is exactly where another dev server is likely to be left running.

## Scope

1. **Ownership by process, not by response.** "Already running" means a SAAKSHI process exists
   (`PAT_API` / `PAT_WEB` in `scripts/lib/processes.sh`), never just that something answered on the port.
2. **A port held by anything else is skipped, not shared.** If `API_PORT` / `WEB_PORT` (defaults 4000
   and 3000) is held by a non-SAAKSHI process, start on the next free port, say so in a warning, and
   print the real URL in the banner.
3. **The chosen ports are recorded** in `.run/ports`, so a second `npm start` reports the right
   URL and `npm run stop`'s port sweep checks the right ports.

### Out of scope
Container ports (Postgres, MinIO, Grafana…). Compose already fails loudly on those.

## Acceptance Criteria

- [ ] With a foreign process on :3000, `npm start` starts SAAKSHI's web on the next free port, warns
      naming the holder, and the banner's `app` URL serves SAAKSHI (`/login` title is SAAKSHI's)
- [ ] With :3000 free, behaviour is unchanged: web on :3000, no warning
- [ ] A second `npm start` reports "already running" with the **actual** ports, and starts nothing
- [ ] `npm run stop` stops the web on whatever port it was given and leaves the foreign holder running
- [ ] The same ownership rule applies to the API port (proven with a foreign listener on :4000)
- [ ] `bash -n` on both scripts; `npm run lint` green; README states the behaviour

## Validation Gate

```bash
npm run stop && npm start                     # with another app on :3000
curl -s "http://localhost:$(grep WEB_PORT .run/ports | cut -d= -f2)/login" | grep -o '<title>[^<]*'
npm start                                     # second run: already running, same ports
npm run stop; lsof -nP -iTCP:3000 -sTCP:LISTEN   # foreign holder still there
npm run lint
```
