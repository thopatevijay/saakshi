---
title: "D4-02 · Judge access: test credentials, seeded demo state, tunnel fallback"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "deploy", "submission"]
blocked_by: ["D4-01"]
estimate: "1.5h"
---

## Context

A judge will open the URL cold, probably once, probably briefly. **An empty or broken first screen is
the whole impression.** The deployed instance must be pre-loaded with a state that tells the story
without anyone driving it.

## Scope

- Create **read-mostly judge accounts**, one per role, with non-guessable passwords
- Seed the deployed instance with a demo state:
  - the full camera registry with trust scores (including at least one measured-vs-declared FPS divergence)
  - a body of sightings and plate reads
  - alerts in mixed states (new / acked / escalated), each with a working crop URL
  - at least one complete trace with a reconstructed observed/inferred route
  - at least one impossible-transition example
  - a verified export bundle and a healthy audit chain
  - the generated gap-analysis report
- A **"Start here"** landing panel for judges: three suggested actions with deep links
  (view the registry · trace this plate · inspect this alert)
- Judge accounts cannot mutate the watchlist or delete cameras; they **can** ack alerts and run traces
- Rate limits sane for external traffic
- **Cloudflare Tunnel fallback** documented and tested, for the case where Railway ingest is blocked
  and a live-feed demonstration must be served from the local machine

## Acceptance Criteria

- [ ] Judge credentials work from a clean browser with no cache and no VPN
- [ ] Landing panel appears on first login with three working deep links
- [ ] Every seeded crop URL resolves (no broken images anywhere) — checked by a link sweep
- [ ] Trace deep link renders a complete route with observed/inferred segments
- [ ] Alert deep link shows a full "why" payload
- [ ] Judge role cannot mutate the watchlist or delete a camera (verified by attempt)
- [ ] Cloudflare Tunnel tested end to end at least once and documented
- [ ] Credentials recorded where the submission form can reference them, and **not** in the repo
- [ ] A second person (or a clean incognito session) completes all three suggested actions
      unaided — recorded as a comment

## Deliverables

- `scripts/seed-demo-state.ts`
- Judge landing panel in `packages/web`
- `docs/judge-walkthrough.md` — what to click, in order, with expected results
- Credentials in `.dev-refs.md` (gitignored) + the submission form

## Validation Gate

```bash
npm run seed:demo-state -- --env production
npm run check:links -- --base https://<web-domain>    # zero broken crops/images
# clean incognito: log in as each judge role, complete the three actions
```

- [ ] Link sweep clean
- [ ] Unaided walkthrough completed and recorded

## Handoff → D4-SUBMIT

The exact URL + credentials go verbatim into the submission form. Do not retype them from memory.
