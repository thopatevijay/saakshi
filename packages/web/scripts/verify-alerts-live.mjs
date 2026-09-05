/**
 * D2-07 AC 1 — "new alerts appear live without a refresh and without shifting the row under the
 * cursor" — and the demo recording that goes with it.
 *
 * ## Why this is a separate script
 *
 * It needs a **third party** to raise an alert: the browser holds an SSE connection, the API fans
 * the alert out, and something else entirely has to put a plate read through the engine. That third
 * party is `npm run demo:alerts -- --live <camera>`, spawned from here, which is also exactly the
 * path a real deployment takes — the consumer that raises alerts is its own process, and the
 * `NOTIFY` fan-out in `alerts.ts` is what carries it to the API replica holding the stream. If the
 * fan-out were broken this script would hang, which is the point.
 *
 * ## The two halves of the criterion, tested separately
 *
 *   **Appears live.** With nothing focused and the list at the top, the alert merges itself and the
 *   row count goes up with no navigation. Asserted by comparing the queue before and after with the
 *   `performance.getEntriesByType('navigation')` count unchanged.
 *
 *   **Without shifting the row under the cursor.** Focus a row, note its id and its exact pixel
 *   offset, raise an alert whose severity and category rank would sort it *above* that row, and
 *   assert the focused row is still the same element at the same offset — the arriving alert is in
 *   the buffer behind the "N new" pill, and only an explicit click moves anything.
 *
 * It also records `docs/screenshots/alerts-live.gif` from a CDP screencast — the raw material
 * D4-03 needs for the demo video, captured while the feeds are known good.
 *
 *   node scripts/verify-alerts-live.mjs <token-file> [base-url] [api-url]
 *
 * Requires `DATABASE_URL` (it spawns the fixture) and alerts already seeded.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, authenticate, navigate, waitFor, check, pass, fail } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../..');
const SHOTS = path.resolve(REPO, 'docs/screenshots');

const token = readFileSync(process.argv[2], 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required — this script spawns the alert fixture');
}

/** Raise one real alert, from a different process, the way a deployment does. */
const raise = (camera) =>
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

const ROW_VISIBLE = `(() => {
  const row = document.querySelector('[data-testid="alert-row"]');
  return row !== null && row.getBoundingClientRect().height > 0;
})()`;

const snapshot = `JSON.stringify((() => {
  const rows = [...document.querySelectorAll('[data-testid="alert-row"]')];
  const active = document.activeElement;
  const box = active === null || active.dataset === undefined || active.dataset.alertId === undefined
    ? null
    : active.getBoundingClientRect();
  return {
    count: Number((document.querySelector('[data-testid="alert-count"]')?.textContent ?? '0').match(/^(\\d+)/)?.[1] ?? 0),
    ids: rows.map((r) => r.dataset.alertId),
    focusedId: active === null ? null : (active.dataset?.alertId ?? null),
    focusedTop: box === null ? null : Math.round(box.top),
    pending: (document.querySelector('[data-testid="new-alerts-pill"]')?.textContent ?? '').trim(),
    navigations: performance.getEntriesByType('navigation').length,
    stream: document.querySelector('[data-testid="stream-status"]')?.dataset.state ?? null,
  };
})())`;

const key = async (cdp, name, code, vk) => {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      ...(type === 'keyDown' ? { text: name } : {}),
      key: name,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
  }
  await new Promise((r) => setTimeout(r, 120));
};

const cdp = await openBrowser({ width: 1680, height: 1050 });
const frames = mkdtempSync(path.join(tmpdir(), 'alerts-live-'));

try {
  await authenticate(cdp, token, 'operator', base);

  /* ── half 1: appears live, with nobody working the queue ────────────────────────────────── */

  console.log('\nAC 1 — a new alert appears live, with no refresh');

  await navigate(cdp, `${base}/alerts?sort=severity`);
  await waitFor(cdp, ROW_VISIBLE, { label: 'the queue' });
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="stream-status"]').dataset.state === 'live'`,
    {
      label: 'the SSE stream to connect',
    },
  );
  pass('the stream reports itself live');

  const before = JSON.parse(await cdp.evaluate(snapshot));

  // Record from here: this is the shot D4-03 wants.
  let index = 0;
  const offScreencast = cdp.on('Page.screencastFrame', (params) => {
    writeFileSync(
      path.join(frames, `frame-${String(index).padStart(4, '0')}.jpg`),
      Buffer.from(params.data, 'base64'),
    );
    index += 1;
    void cdp
      .send('Page.screencastFrameAck', { sessionId: params.sessionId })
      .catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 70,
    everyNthFrame: 1,
    maxWidth: 1400,
  });
  await new Promise((r) => setTimeout(r, 1200));

  console.log(`  raising an alert from another process…`);
  console.log(`    ${await raise('cam02')}`);

  await waitFor(cdp, `${snapshot}.includes('"count":${String(before.count + 1)}')`, {
    timeoutMs: 20000,
    label: 'the queue to grow by one, live',
  });
  const idle = JSON.parse(await cdp.evaluate(snapshot));

  check(
    idle.count === before.count + 1,
    `the queue grew from ${before.count} to ${idle.count} with no refresh`,
  );
  check(
    idle.navigations === before.navigations,
    'no navigation happened — it arrived over the stream',
  );
  check(idle.pending === '', 'nothing was buffered: with no row focused, it merged itself');

  /* ── half 2: the row under the cursor does not move ─────────────────────────────────────── */

  console.log('\nAC 1 — and it does not shift the row under the cursor');

  await cdp.evaluate(`document.querySelector('[data-testid="alert-viewport"]').focus()`);
  await key(cdp, 'j', 'KeyJ', 74);
  await key(cdp, 'j', 'KeyJ', 74);
  const focused = JSON.parse(await cdp.evaluate(snapshot));
  check(
    focused.focusedId !== null,
    `a row is focused (${focused.focusedId}) at y=${focused.focusedTop}`,
  );

  console.log(`  raising another alert while that row is focused…`);
  console.log(`    ${await raise('cam04')}`);

  await waitFor(cdp, `document.querySelector('[data-testid="new-alerts-pill"]') !== null`, {
    timeoutMs: 20000,
    label: 'the new-alert pill',
  });
  const held = JSON.parse(await cdp.evaluate(snapshot));

  check(held.focusedId === focused.focusedId, 'the focused row is still the same alert');
  check(held.focusedTop === focused.focusedTop, `it has not moved a pixel (y=${held.focusedTop})`);
  check(
    held.count === idle.count,
    'the queue length is unchanged — the alert is buffered, not inserted',
  );
  check(
    held.pending.includes('new alert'),
    `the indicator says what is waiting — "${held.pending}"`,
  );

  await new Promise((r) => setTimeout(r, 900));

  // Now merge it explicitly, which is the only thing allowed to move a row.
  await cdp.evaluate(`document.querySelector('[data-testid="new-alerts-pill"]').click()`);
  await waitFor(cdp, `document.querySelector('[data-testid="new-alerts-pill"]') === null`, {
    label: 'the pill to clear',
  });
  const merged = JSON.parse(await cdp.evaluate(snapshot));
  check(merged.count === held.count + 1, `an explicit click merges it (${merged.count} alerts)`);
  check(merged.focusedId === focused.focusedId, 'and the operator keeps their row');

  await new Promise((r) => setTimeout(r, 1500));
  await cdp.send('Page.stopScreencast');
  offScreencast();

  /* ── the recording ──────────────────────────────────────────────────────────────────────── */

  console.log(`\nRecording — ${String(index)} frames captured`);
  const gif = path.join(SHOTS, 'alerts-live.gif');
  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-framerate',
        '12',
        '-pattern_type',
        'glob',
        '-i',
        path.join(frames, 'frame-*.jpg'),
        '-vf',
        'fps=10,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
        gif,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    check(existsSync(gif), `encoded ${gif}`);
  } catch (error) {
    fail(`ffmpeg could not encode the recording: ${String(error)}`);
  }
} finally {
  await cdp.close();
  rmSync(frames, { recursive: true, force: true });
}
