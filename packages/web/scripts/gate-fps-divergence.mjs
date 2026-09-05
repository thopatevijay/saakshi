// D1-GATE AC 4 · captures the declared-vs-measured FPS divergence in the drawer.
import { openBrowser, authenticate, navigate, waitFor, screenshot } from './cdp.mjs';
import { readFileSync } from 'node:fs';

const token = readFileSync(process.argv[2] ?? '/tmp/gate-token', 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
const cameraId = process.argv[4];
const out = process.argv[5] ?? '../../docs/screenshots/day1-fps-divergence.png';

const cdp = await openBrowser();
try {
  await authenticate(cdp, token, 'admin', base);
  await navigate(cdp, `${base}/registry?camera=${cameraId}`);
  await waitFor(cdp, `!!document.querySelector('[data-testid="trust-breakdown"]')`, {
    timeoutMs: 60000,
    label: 'the cam30 drawer',
  });
  await waitFor(cdp, `document.querySelectorAll('[data-signal]').length > 0`, {
    label: 'the signal rows',
  });
  const text = await cdp.evaluate(
    `document.querySelector('[data-testid="camera-drawer"]').innerText`,
  );
  const lines = String(text)
    .split('\n')
    .filter((l) => /declar|measur|fps|resolution|codec/i.test(l));
  console.log('drawer lines mentioning declared/measured:\n  ' + lines.join('\n  '));
  await screenshot(cdp, out);
  console.log('wrote', out);
} finally {
  await cdp.close();
}
