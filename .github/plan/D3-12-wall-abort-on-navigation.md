---
title: "D3-12 · Release the wall's sockets on navigation intent, not on unmount"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "frontend", "bug", "demo-critical"]
blocked_by: []
estimate: "1h"
---

## Context

Raised from a live browser session on 11 Sep 2026, after the owner reported the app freezing when
switching pages. Logged on `BL-01` (#1) with the full measurement.

**Leaving `/video-wall` with 11 tiles live takes 20.6–21.1 s**, measured three times. Ordinary hops
between pages are 53–476 ms. During the stall the tab is genuinely unresponsive — CDP itself gave up
with `the renderer may be frozen or unresponsive`.

It is **not** the server (the target route's RSC payload returns 200 in **118 ms**), **not** a React
leak (zero `<video>` elements remain afterwards), **not** routing config (the sidebar uses real Next
`<Link>`s), and **not** `next dev` compilation (routes compile once in 300–700 ms).

### The actual mechanism — a scheduling deadlock, not a leaky teardown

`use-hls-player.ts` already tears down correctly and deliberately: `hls.destroy()`, then
`removeAttribute('src')`, `srcObject = null`, `video.load()`. Nothing about that is wrong.

The problem is **when React runs it**. In the App Router the outgoing page unmounts only *after* the
router commits the incoming route. So:

```
router waits on its RSC fetch
   └─ RSC fetch is queued behind in-flight HLS segment requests (same origin, ~6 sockets, HTTP/1.1)
        └─ those requests are only aborted on unmount
             └─ unmount only happens once the router commits
```

It resolves at ~21 s only because a fragment eventually completes on its own and frees a socket. The
wall's own header reports why that takes so long: `relay · 45 upstream · 38% cached · 10,344 ms mean`,
and `fragLoadingTimeOut` is deliberately **120 s** so the player does not fight its own relay.

**So the sockets must be released on navigation *intent*, before React is asked to unmount.**

## Scope

- A small teardown registry in `packages/web/src/lib/wall/`: players register a closer; a single call
  closes every open player synchronously.
- `use-hls-player` registers its existing teardown as a closer and deregisters on unmount. **The
  teardown itself does not change** — only who else may trigger it, and when.
- The wall screen installs a **capture-phase** `click` listener that fires the closers when a
  same-origin navigation link outside the wall is clicked. Capture phase is the point: it runs before
  the router's own handler, so the sockets are free by the time the RSC fetch is issued.
- Closing must be idempotent and safe to call when no player is open.

## Out of scope

- Changing the default or persisted grid size (a separate `BL-01` item; 4×4 against a 10 s gateway is
  its own decision)
- Moving the relay to another origin (the structural fix, larger, also on `BL-01`)
- The `2040.82×` delivery-rate display bug (cosmetic, separate `BL-01` item)

## Acceptance Criteria

- [ ] Leaving `/video-wall` with a full grid of tiles completes in **under 2 s**, measured in a real
      browser with the same method that recorded 20.6–21.1 s
- [ ] Ordinary page-to-page navigation is unchanged (53–476 ms band)
- [ ] After leaving, `document.querySelectorAll('video').length === 0` — teardown is still complete
- [ ] Navigating **within** the wall (tile swap, grid resize) does **not** trigger a mass close
- [ ] Closing twice, or closing with no players open, is harmless
- [ ] `npm run test -w @saakshi/web -- wall` green; repo-wide typecheck · lint · format green

## Validation Gate

```bash
npm run typecheck && npm run lint && npm run format:check
npm run test -w @saakshi/web -- wall
```

- [ ] A measured before/after number recorded as a comment, from a real browser session
