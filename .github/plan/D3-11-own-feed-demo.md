---
title: "D3-11 · Record the own-feed demonstration video"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "submission", "mandatory-deliverable"]
blocked_by: ["D2-07", "D2-08", "D3-01", "D3-04"]
estimate: "2h"
---

## Context

**Mandatory submission item 3**: a 2–3 minute screen recording on CCTV footage *of our choice*,
showing onboarding, AI detection, watchlist correlation, and automated real-time alerting.

The rules are explicit: *"Mock-ups, animations, simulated interfaces, or concept videos without an
operational backend will not be considered."* Everything on screen must be the real running system.

Record this on **our own** footage (not the government feed — that is D4-03) so we control the
conditions and can guarantee a hit.

## Scope

- Source: our own recorded CCTV/dashcam/road footage, plus a seeded watchlist entry guaranteed to
  match, so the alert definitely fires on camera
- Storyboard, tight, 2:45 target:
  1. **0:00–0:20** The problem, in one sentence, over the GIS registry (26 silos, 80k cameras)
  2. **0:20–0:45** Onboard our own feed live through an adapter — camera appears on the map with a
     trust score, showing measured-vs-declared FPS
  3. **0:45–1:15** Live detection + ANPR on the video wall with the overlay on
  4. **1:15–1:45** The watchlist match fires: alert arrives with crop, camera, timestamp, "why"
  5. **1:45–2:20** Trace the vehicle: observed vs inferred route, evidence strip
  6. **2:20–2:45** Audit chain verification + export bundle hash — chain of custody
- No slides, no voiceover claims the software does not do; captions only for what is on screen
- 1080p minimum, readable text at YouTube compression

## Acceptance Criteria

- [ ] Length 2:00–3:00
- [ ] Every second is the live system — zero mock-ups, zero animation of non-existent features
- [ ] Onboarding, ANPR, watchlist correlation, and automated alerting all visibly demonstrated
      (these four are the explicitly required elements)
- [ ] Alert fires **on camera**, not cut to after the fact
- [ ] Text legible at 1080p after compression (checked on the actual upload)
- [ ] Uploaded as **unlisted** YouTube; URL recorded
- [ ] No credentials, tokens, personal data, or real third-party plates visible in any frame
      (review frame by frame)

## Deliverables

- Unlisted YouTube URL, recorded in `.dev-refs.md` **and** as a comment on this issue
- `docs/demo-own-feed-storyboard.md`
- Local master file retained (gitignored)

## Validation Gate

- [ ] Watch the upload end to end at 1080p on a different device
- [ ] Confirm every claim in the captions is something visible on screen
- [ ] Confirm no secrets/PII in any frame
- [ ] URL loads in a logged-out browser

## Handoff → D4-03, D4-08

Reuse the storyboard structure for the government-feed video. Keep the master file for re-cuts.
