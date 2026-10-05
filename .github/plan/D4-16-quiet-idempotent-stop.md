---
title: "D4-16 · A repeated `npm run stop` warns about ports it never used and reports work it did not do"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "infra", "bug"]
blocked_by: []
estimate: "30m"
---

## Context

After D4-15, a second `npm run stop` (with SAAKSHI already down) prints:

```
! web port 3000 is held by com.docker.backend (not SAAKSHI) — left alone
✓ containers stopped, volumes preserved
✓ adminer stopped
```

The first `stop` deletes `.run/ports`, so the second falls back to :3000 and warns about another app
SAAKSHI never used. The container and adminer lines print whether or not anything was running. An
operator can't tell from this output whether something was actually stopped.

## Scope

- `stop` never warns about a port held by a non-SAAKSHI process. It never touches one, so there is
  nothing to report. It still kills a SAAKSHI listener on the recorded or default port.
- The container and adminer lines report what happened: "stopped" only if something was running.
- With nothing running, `stop` says so in one line and exits 0.

## Acceptance Criteria

- [ ] `npm run stop` twice in a row: the second run prints no warning and no "stopped" line, only that
      SAAKSHI is already down; exit 0
- [ ] With another app on :3000, no output from `stop` mentions it
- [ ] With SAAKSHI running (web moved to :3002), `stop` still reports each process it stopped, the
      containers, and leaves nothing behind
- [ ] `bash -n scripts/stop.sh`; `npm run lint` green

## Validation Gate

```bash
npm start && npm run stop && npm run stop
pgrep -fl "$(. scripts/lib/processes.sh; echo "$PAT_API|$PAT_WEB|$PAT_WORKER")" || echo clean
```
