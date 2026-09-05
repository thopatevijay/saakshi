// D1-GATE · captures docs/screenshots/day1-slice.png — the registry map with trust-coloured pins.
import { openBrowser, authenticate, navigate, waitFor, screenshot } from './cdp.mjs';
import { readFileSync } from 'node:fs';

const token = readFileSync(process.argv[2] ?? '/tmp/gate-token', 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
const out = process.argv[4] ?? '../../docs/screenshots/day1-slice.png';

const cdp = await openBrowser();
try {
  await authenticate(cdp, token, 'admin', base);
  await navigate(cdp, `${base}/registry`);
  await waitFor(cdp, 'window.__saakshiMapIdle === true', { label: 'map idle' });
  const state = await cdp.evaluate(`JSON.stringify({
    features: (window.__saakshiFeatures?.features ?? []).length,
    errors: (window.__saakshiMapErrors ?? []).length,
  })`);
  console.log('map state:', state);
  await screenshot(cdp, out);
  console.log('wrote', out);
} finally {
  await cdp.close();
}
