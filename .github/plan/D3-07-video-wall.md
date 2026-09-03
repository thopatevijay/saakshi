---
title: "D3-07 · Video wall: HLS grid and WHEP low-latency single camera"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "frontend", "pillar-2"]
blocked_by: ["D1-03", "D1-08"]
estimate: "3h"
---

## Context

Model 2/3 both promise *"unified viewing"* and *"configurable video walls and multi-camera grid
views"*. The organisers expose exactly the two endpoints this needs: HLS for dashboards and
restricted networks, WHEP for low-latency preview. Using both correctly, for their stated purposes,
demonstrates that we read their guide.

## Scope

- Grid view: configurable 2×2 / 3×3 / 4×4 using **HLS** (`hls.js`), lazy-mounted so only visible
  tiles hold a connection
- Single-camera view: **WHEP** (WebRTC) for low latency
- Tile chrome: camera name, department, trust badge, live indicator, last-sighting count
- **Only open the cameras being viewed**, and close captures on unmount — the organisers explicitly
  ask clients to pace their load, and each connected client gets its own copy of the stream
- Overlay toggle: draw current detections/plate boxes on the tile from the live sighting stream
- Graceful degradation: a dead camera shows its trust reason, not a spinner forever
- Fullscreen and per-tile camera swap; layout persisted per user

## Acceptance Criteria

- [ ] 3×3 HLS grid plays 9 sandbox cameras concurrently without audio and without stalling
- [ ] Only visible tiles hold connections — verified in the network tab when scrolling/paging
- [ ] Unmounting a tile **closes** its connection (no leaked streams; verified over a 10-minute session)
- [ ] WHEP single-camera view plays with visibly lower latency than the HLS tile
- [ ] Detection overlay aligns with the video (coordinate transform correct across resolutions)
- [ ] A dead/untrusted camera tile shows the trust reason
- [ ] Layout persists across reload per user
- [ ] Browser memory stable over a 10-minute grid session (no monotonic growth)

## Deliverables

- `packages/web/app/wall/*`
- `docs/screenshots/video-wall.png`
- Clean screen recording of the grid (raw material for the demo videos)

## Validation Gate

```bash
npm run build -w packages/web
npm run test -w packages/web -- wall
```

- [ ] Manual: 10-minute 3×3 session, memory flat, no leaked connections in DevTools
- [ ] Manual: WHEP vs HLS latency compared and noted
- [ ] Recording captured

## Handoff → D4-03

The wall is the opening shot of the government-feed demo video — "here are your cameras, unified".
