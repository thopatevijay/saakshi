/**
 * Records the D3-11 own-feed demonstration master — the six-beat storyboard, end to end, in one
 * continuous take against the real running system.
 *
 * ## Why CDP rather than a desktop screen recorder
 *
 * The same three reasons `record-wall.mjs` gives, and they all matter to a submission whose rules
 * say *"mock-ups, animations, simulated interfaces, or concept videos without an operational
 * backend will not be considered"*: it is **reproducible** (anyone can re-run it and get the same
 * take), it captures the page and nothing else (no menu bar, no cursor, no notification sliding in
 * over the evidence, **no `.env` in a terminal behind the browser**), and it runs headless so the
 * recording does not depend on whose laptop is in front of the camera.
 *
 * There is also a hard constraint: on a machine that has not granted Screen Recording to the
 * terminal, `screencapture` answers `could not create image from display` and ffmpeg's avfoundation
 * lists no screen device at all. CDP has no such dependency.
 *
 * ## Why the frame timings are real
 *
 * Frames arrive from the compositor at whatever rate it paints, which is *not* constant. Each frame
 * is written with its own timestamp and ffmpeg is handed a concat list with real per-frame
 * durations, so the master plays at the speed the system actually ran at. Encoding at a nominal fps
 * would speed up or slow down the recording by however much the machine was misbehaving, and the
 * demonstration would be a lie about the product's responsiveness.
 *
 * ## What this deliberately does NOT do
 *
 * It burns in **no captions and no titles**. The master is raw material for a re-cut (D4-03 reuses
 * it), and every caption in `docs/demo-own-feed-storyboard.md` is a claim that has to be checked
 * against what is on screen at that timestamp. Baking them in here would put them beyond review.
 *
 *   node scripts/record-demo.mjs <token-file> [out] [base-url] [api-url]
 *
 * `<token-file>` must hold a token for a role with `video:view`, `trace:run`, `alerts:acknowledge`
 * and `audit:read` — `admin` or `supervisor`. An `operator` gets a 403 on `/audit` and the audit
 * beat films an error page (docs/rbac.md).
 *
 * Requires `DATABASE_URL`: beat 4 spawns the alert fixture from a separate process, which is what
 * makes the arrival a real fan-out rather than a local re-render.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, authenticate, navigate, waitFor } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../..');

const tokenFile = process.argv[2];
const out = process.argv[3] ?? path.join(REPO, 'docs/recordings/d3-11-own-feed-master.mp4');
const base = process.argv[4] ?? 'http://localhost:3100';

if (tokenFile === undefined)
  throw new Error('usage: record-demo.mjs <token-file> [out] [base-url]');
if (process.env['DATABASE_URL'] === undefined) {
  throw new Error('DATABASE_URL is required — beat 4 spawns the alert fixture');
}

const token = readFileSync(tokenFile, 'utf8').trim();
const frames = path.join(REPO, '.prp/demo-frames');

/** 1080p exactly. The AC is "text legible at 1080p after compression". */
const WIDTH = 1920;
const HEIGHT = 1080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dispatch a real key event, the way `verify-alerts-live.mjs` does. */
async function key(cdp, name, code, vk) {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      ...(type === 'keyDown' ? { text: name.length === 1 ? name : undefined } : {}),
      key: name,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
  }
  await sleep(140);
}

/** Raise one real alert from a different process — a real test of the NOTIFY fan-out. */
const raiseAlert = (camera) =>
  new Promise((resolve, reject) => {
    execFile(
      'npx',
      ['tsx', 'packages/api/src/demo/alert-fixtures.ts', '--live', camera],
      { cwd: REPO, env: process.env },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`${stdout}\n${stderr}`));
        else resolve(stdout.trim());
      },
    );
  });

/** Type into a focused field one character at a time, so it looks like an officer typing. */
async function type(cdp, selector, text) {
  await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  for (const char of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
    await sleep(45);
  }
}

async function main() {
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  mkdirSync(path.dirname(out), { recursive: true });

  const cdp = await openBrowser({ width: WIDTH, height: HEIGHT + 120 });

  // Force the *viewport* to exactly 1920x1080. Without this the browser's own chrome is subtracted
  // from the window and the screencast comes out 1920x992 — which fails the "1080p minimum"
  // criterion by 88 pixels, silently, and only shows up in `ffprobe` after the encode.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await authenticate(cdp, token, 'admin', base);

  // Warm every route before the camera rolls. A first paint that includes Next.js compiling a route
  // is a recording of our start-up, not of the product.
  console.log('  warming routes…');
  for (const route of ['/registry', '/video-wall', '/alerts', '/trace', '/audit']) {
    await navigate(cdp, `${base}${route}`, { timeoutMs: 60000 }).catch(() => undefined);
    await sleep(500);
  }

  const written = [];
  const started = Date.now();
  const marks = [];
  const mark = (label) => {
    const at = (Date.now() - started) / 1000;
    marks.push({ label, at });
    console.log(`  ${at.toFixed(1).padStart(6)}s  ${label}`);
  };

  const off = cdp.on('Page.screencastFrame', (params) => {
    const file = path.join(frames, `f${String(written.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(params.data, 'base64'));
    written.push({ file, at: Date.now() - started });
    void cdp
      .send('Page.screencastFrameAck', { sessionId: params.sessionId })
      .catch(() => undefined);
  });

  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    maxWidth: WIDTH,
    maxHeight: HEIGHT,
    everyNthFrame: 1,
  });

  /* ── Beat 1 · the problem, over the GIS registry ─────────────────────────────────────────── */
  mark('beat 1 — registry: the estate nobody holds in one place');
  await navigate(cdp, `${base}/registry`);
  await waitFor(cdp, `document.querySelector('[data-testid="estate-summary"]') !== null`, {
    label: 'the estate summary',
  });
  await sleep(6000);
  // The coverage overlay is the honest half: cameras exist, trusted coverage does not.
  await cdp
    .evaluate(`document.querySelector('[data-testid="coverage-toggle"]')?.click()`)
    .catch(() => undefined);
  await sleep(7000);

  /* ── Beat 2 · our own feed, onboarded through an adapter ─────────────────────────────────── */
  mark('beat 2 — our own gateway feed: WHEP vs HLS on one source');
  await navigate(cdp, `${base}/video-wall`);
  await waitFor(
    cdp,
    `[...document.querySelectorAll('[data-testid="wall-tile"]')].filter((t) => t.getBoundingClientRect().height > 0).length >= 4`,
    { label: 'the wall to lay out', timeoutMs: 60000 },
  );
  await sleep(5000);
  // Detection overlay on — AI detection, drawn over the feed it was measured from.
  await cdp
    .evaluate(`document.querySelector('[data-testid="wall-overlay-toggle"]')?.click()`)
    .catch(() => undefined);
  await sleep(6000);

  /* ── Beat 3 · our own edge gateway: two transports, one source, one clock ────────────────── */
  //
  // This is the ONLY live video in the demonstration, and it is deliberately ours rather than the
  // government sandbox's. A sandbox camera has no WHEP path — the sandbox is HLS-only (D1-03) — so
  // the single-camera screen for one of those says so in words and shows an empty player. Opening a
  // sandbox tile here would film that empty player and prove nothing.
  //
  // `saakshi-test` is the 640x360 / 25 fps pattern with a **burnt-in timer** that
  // `ops/mediamtx/mediamtx.yml` publishes for exactly this: the difference between the two clocks
  // on screen *is* the latency difference, readable without instrumentation and impossible to fake.
  mark('beat 3 — our own edge gateway: WHEP beside HLS, one source, two clocks');
  await cdp
    .evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open')?.click()`,
    )
    .catch(() => undefined);
  await sleep(2500);
  await cdp
    .evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Compare HLS vs WHEP'))?.click()`,
    )
    .catch(() => undefined);
  // The comparison mounts below the fold, and HLS takes several seconds longer than WHEP to show a
  // first frame — which is itself the point being demonstrated. Scroll it into frame, then hold
  // long enough that BOTH clocks are running and the gap between them can be read off the screen.
  await sleep(2000);
  await cdp.evaluate(`
    document.evaluate(
      "//*[contains(text(), 'the same source through both transports')]",
      document, null, 9, null,
    ).singleNodeValue?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  `);
  await sleep(20000);

  /* ── Beat 4 · the watchlist match, and one that arrives on camera ────────────────────────── */
  mark('beat 4 — alert queue: the claims banner first');
  await navigate(cdp, `${base}/alerts?sort=severity`);
  await waitFor(cdp, `document.querySelector('[data-testid="alert-row"]') !== null`, {
    label: 'the queue',
  });
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="stream-status"]')?.dataset.state === 'live'`,
    { label: 'the SSE stream', timeoutMs: 30000 },
  );
  await sleep(9000); // read the banner: 7 alerts, 5 exact / 2 fuzzy, mock providers, no biometrics

  mark('beat 4 — j then a: the verdict round trip, keyboard only');
  await cdp.evaluate(`document.querySelector('[data-testid="alert-viewport"]').focus()`);
  await key(cdp, 'j', 'KeyJ', 74);
  await sleep(900);
  await key(cdp, 'a', 'KeyA', 65);
  await sleep(2500);

  mark('beat 4 — expand a fuzzy row: the caveats and the provenance note');
  // Move to a fuzzy row and open it — this is the shot that answers "how do you know?".
  await cdp.evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('[data-testid="alert-row"]')];
      const fuzzy = rows.find((r) => r.dataset.matchType === 'fuzzy') ?? rows[1];
      fuzzy?.focus();
      return fuzzy?.dataset.alertId ?? null;
    })()
  `);
  await sleep(700);
  await key(cdp, 'Enter', 'Enter', 13);
  await sleep(11000); // the eight caveats, the "NOT FROM A VEHICLE REGISTRY" note, live: false
  await key(cdp, 'Escape', 'Escape', 27);
  await sleep(800);

  mark('beat 4 — an alert arrives from another process, with no refresh');
  await cdp.evaluate(`window.scrollTo({ top: 0 }); document.activeElement?.blur()`);
  await sleep(1200);
  const before = await cdp.evaluate(
    `Number((document.querySelector('[data-testid="alert-count"]')?.textContent ?? '0').match(/^(\\d+)/)?.[1] ?? 0)`,
  );
  console.log(`    queue before: ${before}`);
  // Start the raiser WITHOUT awaiting it. `npx tsx` takes ~20 s to cold-start, and awaiting the
  // spawn before the dwell films twenty seconds of a queue doing nothing — dead air that reads as
  // the product being slow when it is only Node being slow. Kicking it off first means the arrival
  // lands *inside* the dwell, which is what the criterion "fires on camera" actually asks for.
  const raising = raiseAlert('cam02').catch((error) => `(could not raise: ${String(error)})`);
  await waitFor(
    cdp,
    `Number((document.querySelector('[data-testid="alert-count"]')?.textContent ?? '0').match(/^(\\d+)/)?.[1] ?? 0) > ${before}`,
    { label: 'the queue to grow live', timeoutMs: 30000 },
  ).catch(() => console.log('    (queue did not grow — recorded as it happened)'));
  await sleep(5000);
  console.log(
    `    ${
      String(await raising)
        .split('\n')
        .slice(-1)[0]
    }`,
  );

  /* ── Beat 5 · trace: a purpose first, then observed vs inferred ──────────────────────────── */
  mark('beat 5 — trace lands with the purpose field waiting, and searches nothing');
  await navigate(cdp, `${base}/trace?plate=GJ01AB1234`);
  await waitFor(cdp, `document.querySelector('[data-testid="trace-purpose"]') !== null`, {
    label: 'the trace form',
  });
  await sleep(6500); // "State a purpose before searching GJ01AB1234."

  mark('beat 5 — the officer states a purpose, and only then does it search');
  await type(cdp, '[data-testid="trace-purpose"]', 'FIR 123/2026 vehicle movement');
  await sleep(1200);
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Trace')?.click()`,
  );
  await sleep(9000);
  await cdp.evaluate(`window.scrollTo({ top: 420, behavior: 'smooth' })`);
  await sleep(7000);

  /* ── Beat 6 · the audit chain ────────────────────────────────────────────────────────────── */
  mark('beat 6 — the audit chain, and the limit of what a pass proves');
  await navigate(cdp, `${base}/audit`);
  await sleep(9000);
  await cdp.evaluate(`window.scrollTo({ top: 500, behavior: 'smooth' })`);
  await sleep(6000);

  mark('done');
  await cdp.send('Page.stopScreencast');
  off();
  await cdp.close();

  if (written.length < 2) throw new Error(`only ${String(written.length)} frames captured`);

  /* ── encode, with the real per-frame durations ───────────────────────────────────────────── */
  const lines = [];
  for (let i = 0; i < written.length; i += 1) {
    const next = written[i + 1]?.at ?? written[i].at + 100;
    lines.push(`file '${written[i].file}'`);
    lines.push(`duration ${((next - written[i].at) / 1000).toFixed(3)}`);
  }
  lines.push(`file '${written[written.length - 1].file}'`);
  const list = path.join(frames, 'concat.txt');
  writeFileSync(list, lines.join('\n'));

  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      // libx264 + yuv420p cannot encode an odd dimension, and `-r` is rejected alongside a
      // non-CFR concat input — both are `record-wall.mjs`'s hard-won lessons, kept.
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=25',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      // crf 20 rather than 24: the AC is legibility of small type after YouTube's own re-encode.
      '-crf',
      '20',
      out,
    ],
    { stdio: 'inherit' },
  );

  const seconds = written[written.length - 1].at / 1000;
  console.log(`\n  ${String(written.length)} frames over ${seconds.toFixed(1)} s → ${out}`);
  console.log('\n  beat marks (for the storyboard and the edit):');
  for (const { label, at } of marks) {
    const mm = String(Math.floor(at / 60)).padStart(2, '0');
    const ss = (at % 60).toFixed(1).padStart(4, '0');
    console.log(`    ${mm}:${ss}  ${label}`);
  }
  writeFileSync(`${out}.marks.json`, JSON.stringify({ seconds, marks }, null, 2));
  rmSync(frames, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
