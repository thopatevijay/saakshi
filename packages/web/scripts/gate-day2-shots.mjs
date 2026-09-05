// D2-GATE · captures docs/screenshots/day2-alerts.png and day2-trace.png
import { openBrowser, authenticate, navigate, waitFor, screenshot } from './cdp.mjs';
import { readFileSync } from 'node:fs';

const token = readFileSync(process.argv[2] ?? '/tmp/gate2-token', 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
const plate = process.argv[4] ?? 'GJ3266416';

const cdp = await openBrowser({ width: 1600, height: 1000 });
try {
  await authenticate(cdp, token, 'admin', base);

  await navigate(cdp, `${base}/alerts`);
  await waitFor(
    cdp,
    `(() => {
       const t = document.querySelector('main')?.innerText ?? '';
       if (!t || /Loading/i.test(t)) return false;
       return document.querySelectorAll('[data-testid="alert-row"]').length > 0;
     })()`,
    { timeoutMs: 60000, label: 'alert rows settled' },
  );
  const rows = await cdp.evaluate(`document.querySelectorAll('[data-testid="alert-row"]').length`);
  console.log('alert rows rendered:', rows);
  await screenshot(cdp, '../../docs/screenshots/day2-alerts.png');
  console.log('wrote day2-alerts.png');

  await navigate(cdp, `${base}/trace?plate=${plate}`);
  await waitFor(
    cdp,
    `(() => { const t = document.querySelector('main')?.innerText ?? ''; return t.length > 0 && !/Loading/i.test(t); })()`,
    { timeoutMs: 60000, label: 'trace content settled' },
  );
  const txt = await cdp.evaluate(`document.querySelector('main')?.innerText?.slice(0,300)`);
  console.log('trace page says:', JSON.stringify(String(txt).replace(/\n+/g, ' | ')));
  await screenshot(cdp, '../../docs/screenshots/day2-trace.png');
  console.log('wrote day2-trace.png');
} finally {
  await cdp.close();
}
