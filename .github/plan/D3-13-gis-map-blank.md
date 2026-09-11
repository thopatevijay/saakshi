---
title: "D3-13 · The GIS map never renders — Model 1's compulsory deliverable is blank"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "frontend", "bug", "demo-critical", "pillar-1"]
blocked_by: []
estimate: "2h"
---

## Context

**Severity: this is the most urgent open defect in the project.** Model 1 — *Centralised CCTV
Registry & GIS Mapping* — is the **compulsory** model. Its map is blank on every screen that has
one, and it reproduces in a **production build**, so it is not a `next dev` artifact.

Found 11 Sep 2026 by driving the running app in Chrome after the owner reported *"app frozen on the
Trace page, nothing happens"*. The freeze is the map panel, not the page.

**It is a regression.** D1-08 (#12) shipped a verified screenshot of this map working —
`docs/screenshots/d1-08-registry-map.png` — plus `verify-map.mjs`, which checks feature coordinates
against PostGIS through the `window.__saakshiMap` handle.

## Symptoms

| Screen | Behaviour |
|---|---|
| `/registry` | stuck on the `Loading map…` placeholder indefinitely, in **dev and production** |
| `/trace` | map container renders, canvas exists, **no basemap tiles ever draw** |

Forcing a remount on `/registry` (toggle **Table** → **Map**) *does* mount the component — and the
map instance is then completely inert:

```
styleLoaded : false
sourceCaches: []            ← the style's own `basemap` source never enters the cache
events      : none at all   ← no styledata, no dataloading, no sourcedata, no error, over 9 s
__saakshiMapErrors: []
```

A MapLibre instance that emits **no events whatsoever** is not misconfigured; it is not running.

## Ruled out, each with evidence

- **Basemap serving is correct.** `GET /basemap/gujarat.pmtiles` with `Range: bytes=0-16383` returns
  **206**, `Content-Range: bytes 0-16383/29781693`, `Accept-Ranges: bytes`, and the payload begins
  with the `PMTiles` magic. The 28 MB archive is present and intact.
- **The protocol is registered before the map is constructed.** `registerMapGlobals()` (which calls
  `addProtocol('pmtiles', new Protocol().tile)`) runs immediately before `new MlMap(...)` in both
  `registry-map.tsx` and `trace-map.tsx`.
- **Not a zero-height container.** The real container measures 2159 px; forcing a height and calling
  `resize()` changes nothing.
- **No errors anywhere.** Clean browser console, no failed network requests, no server-side compile
  errors, `__saakshiMapErrors` empty.
- **Dependencies resolve.** `maplibre-gl@5.24.0` and `pmtiles@4.5.0`, both with `dist/` present.
- **Chunks load.** 22 JS chunks, none failed, none stalled.
- **Not dev-only.** `npm run build -w @saakshi/web` succeeds (exit 0) and `next start` reproduces it
  identically.
- **Not glyphs.** No `text-font` stacks were pending when probed.

## The strongest lead

`maplibre-gl` **was found broken once already today** — empty directories, `npm ls` reporting
`invalid` — and was reinstalled mid-session (BL-01, #1: the worktree `npm install` hazard, where an
install inside `.claude/worktrees/` prunes straight through a symlink into the main checkout). The
current tree may be subtly wrong in a way `npm ls` does not surface: a partially-written package, a
duplicated copy, or a worker bundle that fails silently.

**First thing to try:** `rm -rf node_modules packages/*/node_modules && npm ci`, then re-test. If
that fixes it, the lockfile was fine and the installed tree was not — and that belongs in the
deployment notes for D4-01, because a Railway build runs `npm ci` from the lockfile and would then
be unaffected.

## Acceptance Criteria

- [ ] `/registry` renders the basemap with camera pins on a **cold load**, no remount needed
- [ ] `/trace` renders the basemap with the observed/inferred route drawn over it
- [ ] Verified in a **production build**, not only `next dev`
- [ ] `window.__saakshiMapIdle` becomes `true` and `sourceCaches` contains `basemap`
- [ ] `node packages/web/scripts/verify-map.mjs` passes — D1-08 wrote it for exactly this
- [ ] Root cause **stated**, not merely "reinstalling fixed it" — if it was the dependency tree, say
      which package and how it broke, so D4-01's deploy does not inherit it
- [ ] A screenshot committed, replacing/confirming `docs/screenshots/d1-08-registry-map.png`

## Validation Gate

```bash
npm run build -w @saakshi/web
node packages/web/scripts/verify-map.mjs <token> http://localhost:3100
```

- [ ] Map renders on a cold load in the production build
