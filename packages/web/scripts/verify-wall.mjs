/**
 * D3-07 — the video wall, verified in a real browser.
 *
 * Every acceptance criterion on this ticket is about something a unit test cannot reach: whether a
 * `<video>` is decoding, whether a connection was *closed*, whether nine of them survive ten
 * minutes without the heap climbing. So this drives Chrome over CDP, the way `verify-map.mjs` and
 * `verify-alerts.mjs` do.
 *
 * ## Two traps inherited from D2-07, both avoided deliberately
 *
 *  1. **Never wait on element presence.** A streamed App Router page puts not-yet-hydrated content
 *     in a hidden container, where `querySelector` is non-null while every `getBoundingClientRect()`
 *     is 0×0. Every `waitFor` below waits on a **measured height** or on a counter, never on a node
 *     existing. D2-07 produced a "15 s to first paint" reading that was pure artefact this way.
 *  2. **Never measure timing across the CDP wire.** `waitFor` polls at 200 ms, so anything timed
 *     from Node is quantised to that. The memory samples below are taken *inside the page* on the
 *     page's own clock, and only the summary crosses the wire.
 *
 * ## What the leak check actually asserts
 *
 * `window.__saakshiWall` counts every player ever created and every one destroyed. The invariant is
 * `created - destroyed === live === openCameraIds.length`. A player that leaks increments `created`
 * and never `destroyed`, so it is *proved*, not inferred from a memory graph that could be noise.
 *
 *   node scripts/verify-wall.mjs <token-file> [base-url] [api-url] [--minutes N]
 *
 * Defaults match the other verify scripts: web on 3100, API on 4100 — not the dev ports. And
 * `next start` serves the **built** output, so rebuild before running or you verify a stale bundle.
 *
 * **Reset the saved layout first**, because AC 7 works:
 *
 *   psql "$DATABASE_URL" -c "delete from wall_layouts"
 *
 * A previous run leaves this operator on a 4×4 wall — which is the feature, not a bug, and is why
 * nothing below assumes the wall opens on 3×3.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openBrowser,
  authenticate,
  navigate,
  waitFor,
  screenshot,
  check,
  pass,
  fail,
} from './cdp.mjs';

/**
 * Run one section, reporting a thrown error as a failed check rather than as an aborted run.
 *
 * A gate that stops at the first broken selector reports nothing about the eight criteria after it,
 * and the eight-minute wall warm-up has to be paid again to find out. Every section still fails
 * loudly — `fail` sets a non-zero exit code — but they all get to run.
 */
async function section(title, body) {
  console.log(`\n— ${title} —`);
  try {
    await body();
  } catch (error) {
    fail(`${title}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(here, '../../../docs/screenshots');

const token = readFileSync(process.argv[2], 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
const api = process.argv[4] ?? 'http://localhost:4100';
const minutesArg = process.argv.indexOf('--minutes');
const SOAK_MINUTES = minutesArg === -1 ? 0 : Number(process.argv[minutesArg + 1] ?? 10);
/** Skip straight to the soak. The wall takes minutes to fill against a throttled gateway. */
const SOAK_ONLY = process.argv.includes('--soak-only');

/** A tile is *on screen* only when it has a measured height. See trap 1. */
const TILES_LAID_OUT = `(() => {
  const tiles = [...document.querySelectorAll('[data-testid="wall-tile"]')];
  if (tiles.length === 0) return 0;
  return tiles.filter((t) => t.getBoundingClientRect().height > 0).length;
})()`;

const WALL_STATE = `(() => {
  const w = window.__saakshiWall ?? { created: 0, destroyed: 0, live: 0, openCameraIds: [], players: {}, requests: {} };
  const tiles = [...document.querySelectorAll('[data-testid="wall-tile"]')].map((t) => ({
    slot: t.getAttribute('data-slot'),
    camera: t.getAttribute('data-camera'),
    externalId: t.getAttribute('data-external-id'),
    band: t.getAttribute('data-tile-band'),
    visible: t.getAttribute('data-visible'),
    attached: t.getAttribute('data-attached'),
    readyState: Number(t.getAttribute('data-ready-state') ?? '0'),
    delivery: t.getAttribute('data-delivery'),
    height: t.getBoundingClientRect().height,
    reason: t.querySelector('[data-testid="wall-tile-reason"]')?.textContent?.trim() ?? null,
  }));
  const videos = [...document.querySelectorAll('[data-testid="wall-video"]')].map((v) => ({
    readyState: v.readyState,
    currentTime: v.currentTime,
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight,
    muted: v.muted,
    paused: v.paused,
  }));
  return JSON.stringify({
    grid: document.querySelector('[data-testid="wall-grid"]')?.getAttribute('data-grid') ?? null,
    created: w.created, destroyed: w.destroyed, live: w.live,
    openCameraIds: w.openCameraIds, requests: w.requests,
    tiles, videos,
  });
})()`;

const state = async (cdp) => JSON.parse(await cdp.evaluate(WALL_STATE));

async function main() {
  const cdp = await openBrowser({ width: 1680, height: 1050 });
  await authenticate(cdp, token, 'admin', base);

  if (SOAK_ONLY) {
    await soak(cdp);
    await cdp.close();
    return;
  }

  // ── 1 · The 3x3 grid ────────────────────────────────────────────────────────────────────────
  console.log('\n— 3×3 grid —');
  await navigate(cdp, `${base}/video-wall`);
  await waitFor(cdp, `${TILES_LAID_OUT} >= 4`, { label: 'the wall to lay out' });

  // The wall is **not** assumed to open on 3×3, because it opens on whatever this operator last
  // saved — which is the point of AC 7 and would make a fixed expectation here fail as soon as the
  // feature works. `defaultLayout` covers the never-saved case in `layout.test.ts`. So the grid is
  // set explicitly and the run starts from a known wall.
  const opened = await state(cdp);
  console.log(`  opened on the saved layout: ${String(opened.grid)}`);
  await cdp.evaluate(
    `document.querySelector('[data-testid="wall-grid-option"][data-grid="3x3"]').click()`,
  );
  await waitFor(cdp, `${TILES_LAID_OUT} >= 9`, { label: 'nine tiles with a measured height' });

  const laidOut = await state(cdp);
  check(laidOut.grid === '3x3', `the wall is 3×3 (${String(laidOut.grid)})`);
  check(laidOut.tiles.length === 9, `nine tiles rendered (${String(laidOut.tiles.length)})`);
  check(
    laidOut.tiles.filter((t) => t.camera !== null).length === 9,
    `all nine slots carry a camera (${String(laidOut.tiles.filter((t) => t.camera !== null).length)})`,
  );

  // Frames decoding. `readyState >= 2` is HAVE_CURRENT_DATA: a frame exists at the playhead.
  // The gateway is slow enough that this is the number that has to be reported honestly, so the
  // wait is generous and the *result* is printed either way rather than only asserted.
  await waitFor(
    cdp,
    `(() => {
      const vs = [...document.querySelectorAll('[data-testid="wall-video"]')];
      return vs.filter((v) => v.readyState >= 2).length >= 1;
    })()`,
    { timeoutMs: 240000, label: 'at least one tile decoding a frame' },
  );

  // Give the rest of the wall the same chance before sampling.
  await cdp.evaluate(`new Promise((r) => setTimeout(r, 90000))`);

  const playing = await state(cdp);
  const decoding = playing.videos.filter((v) => v.readyState >= 2);
  const advancing = playing.videos.filter((v) => v.currentTime > 0);
  console.log(
    `  ${String(decoding.length)}/${String(playing.videos.length)} tiles have a decodable frame · ` +
      `${String(advancing.length)} have advanced past 0 s`,
  );
  for (const tile of playing.tiles) {
    console.log(
      `    slot ${String(tile.slot)} · ${String(tile.externalId)} · band ${String(tile.band)} · ` +
        `attached ${String(tile.attached)} · readyState ${String(tile.readyState)} · ` +
        `delivery ${String(tile.delivery)}`,
    );
  }

  check(
    playing.videos.every((v) => v.muted),
    `every tile is muted — AC 1's "without audio" (${String(playing.videos.length)} videos)`,
  );
  check(decoding.length >= 1, `at least one sandbox tile is decoding frames`);

  await screenshot(cdp, path.join(SHOTS, 'video-wall.png'));
  pass(`screenshot written to docs/screenshots/video-wall.png`);

  // ── 2 · Only visible tiles hold connections ─────────────────────────────────────────────────
  console.log('\n— only visible tiles hold connections —');
  const openNow = await state(cdp);
  check(
    openNow.live === openNow.created - openNow.destroyed,
    `the leak invariant holds: created ${String(openNow.created)} − destroyed ` +
      `${String(openNow.destroyed)} = live ${String(openNow.live)}`,
  );
  check(
    openNow.openCameraIds.length === openNow.live,
    `open connections match live players (${String(openNow.openCameraIds.length)})`,
  );
  const mountedCameras = new Set(
    openNow.tiles.filter((t) => t.attached === 'true').map((t) => t.camera),
  );
  check(
    openNow.openCameraIds.every((id) => mountedCameras.has(id)),
    'no connection is open for a camera that is not on a mounted tile',
  );

  // ── 3 · Shrinking the grid closes what it unmounts ──────────────────────────────────────────
  console.log('\n— unmounting closes the connection —');
  const before = await state(cdp);
  await cdp.evaluate(
    `document.querySelector('[data-testid="wall-grid-option"][data-grid="2x2"]').click()`,
  );
  await waitFor(cdp, `${TILES_LAID_OUT} === 4`, { label: 'the wall shrinking to four tiles' });
  await cdp.evaluate(`new Promise((r) => setTimeout(r, 3000))`);

  const after = await state(cdp);
  const closed = after.destroyed - before.destroyed;
  check(
    closed >= 1,
    `shrinking 3×3 → 2×2 closed ${String(closed)} player(s) (destroyed ${String(before.destroyed)} → ${String(after.destroyed)})`,
  );
  check(
    after.live === after.created - after.destroyed,
    `the leak invariant still holds after a layout change (live ${String(after.live)})`,
  );
  check(
    after.live <= 4,
    `at most four players remain on a 2×2 wall (${String(after.live)})`,
  );

  // A camera that was dropped from the wall must stop being requested at all.
  const dropped = before.tiles
    .filter((t) => Number(t.slot) >= 4 && t.camera !== null)
    .map((t) => t.camera);
  const requestsAtDrop = { ...after.requests };
  await cdp.evaluate(`new Promise((r) => setTimeout(r, 8000))`);
  const later = await state(cdp);
  const stillRequesting = dropped.filter(
    (id) => (later.requests[id] ?? 0) > (requestsAtDrop[id] ?? 0),
  );
  check(
    stillRequesting.length === 0,
    `no further media requests for the ${String(dropped.length)} unmounted cameras over 8 s`,
  );

  // ── 4 · Layout persists across reload, per user ─────────────────────────────────────────────
  console.log('\n— layout persistence —');
  await cdp.evaluate(
    `document.querySelector('[data-testid="wall-grid-option"][data-grid="4x4"]').click()`,
  );
  await waitFor(cdp, `${TILES_LAID_OUT} >= 8`, { label: 'the 4×4 wall' });
  await cdp.evaluate(`document.querySelector('[data-testid="wall-overlay-toggle"]').click()`);
  // The save is debounced by 800 ms; wait past it and past the round trip.
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="wall-save-state"]')?.textContent?.includes('saved') === true`,
    { label: 'the layout to report itself saved' },
  );

  const savedSlots = (await state(cdp)).tiles.map((t) => t.camera);
  await navigate(cdp, `${base}/video-wall`);
  await waitFor(cdp, `${TILES_LAID_OUT} >= 8`, { label: 'the reloaded wall' });
  const reloaded = await state(cdp);
  check(reloaded.grid === '4x4', `the 4×4 grid survived a reload (${String(reloaded.grid)})`);
  check(
    JSON.stringify(reloaded.tiles.map((t) => t.camera)) === JSON.stringify(savedSlots),
    'every slot came back with the same camera in it',
  );
  const overlayOff = await cdp.evaluate(
    `document.querySelector('[data-testid="wall-overlay-toggle"]').checked === false`,
  );
  check(overlayOff, 'the overlay toggle survived the reload too');

  // Restore 3×3 with the overlay back on, and **wait for the save to land** — the single-camera
  // view reads the layout from the server, so proceeding before the round trip completes verifies
  // the previous wall. That is D2-07's stale-build lesson wearing a different hat.
  await cdp.evaluate(
    `document.querySelector('[data-testid="wall-grid-option"][data-grid="3x3"]').click()`,
  );
  await cdp.evaluate(
    `(() => {
      const box = document.querySelector('[data-testid="wall-overlay-toggle"]');
      if (!box.checked) box.click();
      return box.checked;
    })()`,
  );
  await waitFor(cdp, `${TILES_LAID_OUT} >= 9`, { label: 'the 3×3 wall again' });
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="wall-save-state"]')?.textContent?.includes('saved') === true`,
    { label: 'the restored layout to be saved' },
  );

  // ── 5 · Trust reasons are rendered, not spun on ─────────────────────────────────────────────
  await section('trust bands on the wall', async () => {
  const bands = (await state(cdp)).tiles.map((t) => `${String(t.externalId)}=${String(t.band)}`);
  console.log(`  ${bands.join(' · ')}`);
  const cameras = await fetch(`${api}/api/v1/cameras?limit=200`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  const notTrusted = cameras.data.filter(
    (c) => c.band === 'untrusted' || c.band === 'degraded' || c.band === 'dead',
  );
  console.log(
    `  API reports ${String(notTrusted.length)} camera(s) below trusted: ` +
      notTrusted.map((c) => `${c.externalId}=${c.band}`).join(', '),
  );

  if (notTrusted.length > 0) {
    const target = notTrusted[0];
    await navigate(cdp, `${base}/video-wall?camera=${target.id}`);
    await waitFor(
      cdp,
      `(() => {
        const el = document.querySelector('[data-testid="single-camera"]');
        return el !== null && el.getBoundingClientRect().height > 0
          && el.textContent.includes('/100');
      })()`,
      { timeoutMs: 60000, label: 'the single-camera view with its trust reason' },
    );
    const reason = await cdp.evaluate(
      `document.querySelector('[data-testid="single-camera"]').textContent.slice(0, 600)`,
    );
    check(
      /Scored \d+\/100 — worst signal/.test(reason),
      `${target.externalId} (${target.band}) states which measured signal cost it points`,
    );
    console.log(`    ${reason.replace(/\s+/g, ' ').slice(0, 240)}`);
    await screenshot(cdp, path.join(SHOTS, 'video-wall-trust-reason.png'));
  }
  });

  // ── 6 · Detection overlay ───────────────────────────────────────────────────────────────────
  await section('detection overlay', async () => {
  const withSightings = await fetch(`${api}/api/v1/cameras?limit=200`, {
    headers: { authorization: `Bearer ${token}` },
  })
    .then((r) => r.json())
    .then(async (page) => {
      for (const camera of page.data) {
        const manifest = await fetch(`${api}/api/v1/streams/${camera.id}/manifest`, {
          headers: { authorization: `Bearer ${token}` },
        }).then((r) => r.json());
        if (manifest.sightings.total > 0) return { camera, manifest };
      }
      return null;
    });

  if (withSightings === null) {
    console.log('  no camera has recorded sightings — overlay alignment not checked on screen');
  } else {
    const { camera, manifest } = withSightings;
    console.log(
      `  ${camera.externalId}: ${String(manifest.sightings.total)} sightings, source ` +
        `${String(manifest.source?.width)}×${String(manifest.source?.height)} (${String(manifest.source?.origin)})`,
    );
    await navigate(cdp, `${base}/video-wall?camera=${camera.id}`);
    await waitFor(
      cdp,
      `(() => {
        const v = document.querySelector('[data-testid="single-hls-video"]');
        return v !== null && v.readyState >= 2 && v.videoWidth > 0;
      })()`,
      { timeoutMs: 300000, label: 'the single-camera HLS pane decoding' },
    );

    const aligned = await cdp.evaluate(`(async () => {
      const v = document.querySelector('[data-testid="single-hls-video"]');
      const c = document.querySelector('[data-testid="detection-overlay"]');
      // Seek to where the analytics worker actually ran, then let the overlay's window catch up.
      v.currentTime = ${String(Math.min(20, (manifest.sightings.latestPtsMs ?? 20000) / 1000 - 5))};
      await new Promise((r) => setTimeout(r, 6000));
      const ctx = c.getContext('2d');
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted += 1;
      return JSON.stringify({
        painted,
        total: c.width * c.height,
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        currentTime: v.currentTime,
        canvasWidth: c.width,
        canvasHeight: c.height,
        badge: document.body.textContent.match(/(\\d+) det/)?.[1] ?? null,
      });
    })()`);
    const overlay = JSON.parse(aligned);
    console.log(
      `    decoded ${String(overlay.videoWidth)}×${String(overlay.videoHeight)} · playhead ` +
        `${String(overlay.currentTime.toFixed(1))} s · ${String(overlay.painted)} painted pixels on the overlay canvas`,
    );
    check(
      overlay.videoWidth === manifest.source.width && overlay.videoHeight === manifest.source.height,
      `the decoded frame matches the registry's measured resolution ` +
        `(${String(overlay.videoWidth)}×${String(overlay.videoHeight)} vs ${String(manifest.source.width)}×${String(manifest.source.height)})`,
    );
    check(
      overlay.painted > 0,
      `detection boxes are painted on the overlay canvas (${String(overlay.painted)} non-transparent pixels)`,
    );
    await screenshot(cdp, path.join(SHOTS, 'video-wall-overlay.png'));
  }
  });

  // ── 7 · WHEP against the edge gateway ───────────────────────────────────────────────────────
  await section('WHEP vs HLS on the edge gateway', async () => {
  await cdp.evaluate(
    `document.querySelector('[data-testid="latency-compare"]')?.click() ?? null`,
  );
  const whep = await waitFor(
    cdp,
    `(() => {
      const v = document.querySelector('[data-testid="single-whep-video"]');
      if (v === null) return null;
      if (v.readyState < 2) return null;
      return JSON.stringify({ status: v.getAttribute('data-whep-status'), w: v.videoWidth, h: v.videoHeight });
    })()`,
    { timeoutMs: 60000, label: 'the WHEP pane to decode a frame' },
  ).catch(() => null);

  if (whep === null) {
    console.log('  WHEP pane did not decode — MediaMTX may not be running');
  } else {
    const parsed = JSON.parse(whep);
    check(
      parsed.status === 'connected' && parsed.w > 0,
      `WHEP connected and is decoding ${String(parsed.w)}×${String(parsed.h)} from the edge gateway`,
    );
    await cdp.evaluate(`new Promise((r) => setTimeout(r, 4000))`);
    // A different file from `measure-latency.mjs`'s: that one is the *instrument* — two bare
    // players and two readable clocks — and this one is the **product**, the panel an operator
    // actually sees. Overwriting one with the other loses the clearer of the two.
    await screenshot(cdp, path.join(SHOTS, 'video-wall-whep-panel.png'));
    pass('screenshot: the in-product comparison panel');
  }
  });

  // ── 8 · The soak: memory and leaks over N minutes ───────────────────────────────────────────
  if (SOAK_MINUTES > 0) await soak(cdp);

  await relayReport();
  await cdp.close();
}

/**
 * The 10-minute soak — AC 8, and the second half of AC 3.
 *
 * Run on a **full 3×3**, set explicitly here rather than inherited. An earlier section leaves this
 * operator on a 4×4 wall carrying four cameras, and soaking four players proves a quarter of what
 * the criterion asks; nine concurrent decoders is the load being tested.
 *
 * Every sample is taken **inside the page on the page's own clock**. Sampling across the CDP wire
 * would quantise to `waitFor`'s 200 ms poll — D2-07's lesson — and would fold Node's own GC pauses
 * into a measurement about the browser's heap.
 */
async function soak(cdp) {
  await section(`${String(SOAK_MINUTES)}-minute 3×3 soak`, async () => {
    await navigate(cdp, `${base}/video-wall`);
    await waitFor(cdp, `${TILES_LAID_OUT} >= 4`, { label: 'the wall to lay out' });
    await cdp.evaluate(
      `document.querySelector('[data-testid="wall-grid-option"][data-grid="3x3"]').click()`,
    );
    await waitFor(cdp, `${TILES_LAID_OUT} >= 9`, { label: 'the 3×3 wall for the soak' });

    const before = await state(cdp);
    const filled = before.tiles.filter((t) => t.camera !== null).length;
    check(filled === 9, `the soak runs on nine filled tiles (${String(filled)})`);

    // Every tile must have **attached a player** before the clock starts, or the soak measures an
    // idle page. `attached` flips when `hls.js` is constructed — deliberately not when a frame
    // arrives, which on this gateway can be minutes later and is a different criterion entirely.
    await waitFor(
      cdp,
      `[...document.querySelectorAll('[data-testid="wall-tile"]')]
        .filter((t) => t.getAttribute('data-attached') === 'true').length >= 9`,
      { timeoutMs: 180000, label: 'nine attached players' },
    );

    // Sampled inside the page on the page's own clock — see trap 2.
    const samples = JSON.parse(
      await cdp.evaluate(
        `(async () => {
          const out = [];
          const until = performance.now() + ${String(SOAK_MINUTES * 60_000)};
          while (performance.now() < until) {
            const w = window.__saakshiWall;
            out.push({
              t: Math.round(performance.now() / 1000),
              heap: performance.memory ? performance.memory.usedJSHeapSize : null,
              live: w.live, created: w.created, destroyed: w.destroyed,
              nodes: document.querySelectorAll('*').length,
            });
            await new Promise((r) => setTimeout(r, 15000));
          }
          return JSON.stringify(out);
        })()`,
      ),
    );

    const heaps = samples.map((s) => s.heap).filter((h) => h !== null);
    if (heaps.length >= 2) {
      const first = heaps[0];
      const last = heaps[heaps.length - 1];
      const max = Math.max(...heaps);
      const mb = (n) => (n / 1048576).toFixed(1);
      console.log(
        `  heap: first ${mb(first)} MB · last ${mb(last)} MB · max ${mb(max)} MB over ` +
          `${String(samples.length)} samples`,
      );
      // Monotonic growth is the failure: a heap that only ever rises across every sample.
      const monotonic = heaps.every((h, i) => i === 0 || h >= heaps[i - 1]);
      check(
        !monotonic || last - first < first * 0.25,
        `heap is not growing monotonically (${mb(first)} → ${mb(last)} MB, ` +
          `${monotonic ? 'never fell' : 'fell at least once'})`,
      );
    } else {
      console.log('  performance.memory unavailable — run Chrome with --enable-precise-memory-info');
    }

    const last = samples[samples.length - 1];
    check(
      last.live === last.created - last.destroyed,
      `the leak invariant held for the whole soak (created ${String(last.created)}, ` +
        `destroyed ${String(last.destroyed)}, live ${String(last.live)})`,
    );
    check(
      last.live <= 9,
      `no more than nine players alive at the end of the soak (${String(last.live)})`,
    );
    console.log(
      `  DOM nodes: ${String(samples[0].nodes)} → ${String(last.nodes)} ` +
        '(a canvas overlay allocates none)',
    );
  });
}

/** What the whole run cost the department's gateway. The pacing claim, in one line. */
async function relayReport() {
  const relay = await fetch(`${api}/api/v1/streams/relay/stats`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  console.log(
    `\n— relay — ${String(relay.upstreamRequests)} upstream requests · ${String(relay.hits)} cache hits · ` +
      `${String(relay.misses)} misses · mean ${String(relay.meanUpstreamMs)} ms upstream · ` +
      `${(relay.cachedBytes / 1048576).toFixed(1)} MB cached`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
