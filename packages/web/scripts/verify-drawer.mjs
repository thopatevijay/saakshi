/**
 * AC 5 — "Detail drawer shows the full trust breakdown, not just the score."
 *
 * The score's credibility rests entirely on somebody being able to click a camera and see **which
 * signal cost it points**. So this asserts the drawer renders one row per signal the API returned,
 * with the raw measurement and the points, plus every *excluded* signal with its reason — the half
 * that a naive breakdown drops, and the half that explains why a VOD camera is not penalised for
 * clock drift.
 *
 * `cam09` (35.00, untrusted) and `cam22` (55.00, degraded) are the two the deck screenshots use:
 * one that the score condemns, and one that scores in the middle while being effectively blind.
 *
 *   node scripts/verify-drawer.mjs <token-file> [base-url] [api-url]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { authenticate, check, navigate, openBrowser, screenshot, waitFor } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(here, '../../../docs/screenshots');

const token = readFileSync(process.argv[2], 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
const api = process.argv[4] ?? 'http://localhost:4100';

const apiGet = (p) =>
  fetch(`${api}${p}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());

const cdp = await openBrowser();
await authenticate(cdp, token, 'admin', base);

const list = await apiGet('/api/v1/cameras?limit=500');
const byExternalId = new Map(list.data.map((c) => [c.externalId, c]));

console.log('\nAC 5 · the drawer shows the whole breakdown\n');

for (const externalId of ['cam09', 'cam22']) {
  const camera = byExternalId.get(externalId);
  if (camera === undefined) {
    console.error(`  ${externalId} is not in the registry — cannot verify`);
    process.exitCode = 1;
    continue;
  }

  const trust = await apiGet(`/api/v1/cameras/${camera.id}/trust`);
  // The drawer is addressable: `?camera=<id>` opens it, which is what makes a link shareable.
  await navigate(cdp, `${base}/registry?camera=${camera.id}`);
  await waitFor(cdp, `!!document.querySelector('[data-testid="trust-breakdown"]')`, {
    timeoutMs: 60000,
    label: `the ${externalId} drawer`,
  });
  await waitFor(cdp, `document.querySelectorAll('[data-signal]').length > 0`, {
    label: 'the signal rows',
  });

  const rendered = await cdp.evaluate(`(() => {
    const cell = (tr, n) => tr.children[n]?.textContent?.trim() ?? '';
    return JSON.stringify({
      band: document.querySelector('[data-drawer-band]')?.getAttribute('data-drawer-band'),
      signals: [...document.querySelectorAll('[data-signal]')].map((tr) => ({
        signal: tr.getAttribute('data-signal'),
        raw: cell(tr, 1),
        weight: cell(tr, 2),
        points: cell(tr, 3),
      })),
      excluded: [...document.querySelectorAll('[data-excluded]')].map((li) => ({
        signal: li.getAttribute('data-excluded'),
        text: li.textContent.trim(),
      })),
      hasHealth: document.body.textContent.includes('Latest health check'),
      hasDelta: document.body.textContent.includes('Declared vs measured'),
      hasPreview: !!document.querySelector('[data-testid="camera-drawer"] button[disabled]'),
      pointsTotal: [...document.querySelectorAll('tfoot td')].map((td) => td.textContent.trim()),
      badges: [...document.querySelectorAll('[data-testid="camera-drawer"] span[title]')]
        .map((s) => s.textContent.trim()).filter((t) => t.includes('·')),
    });
  })()`).then(JSON.parse);

  console.log(
    `  ${externalId} · score ${String(trust.score)} · band ${String(trust.band)} · ` +
      `${String(trust.breakdown.signals.length)} signals · ${String(trust.breakdown.excluded.length)} excluded`,
  );

  check(
    rendered.band === trust.band,
    `${externalId}: the drawer badge shows the API band (${String(rendered.band)})`,
  );
  check(
    rendered.signals.length === trust.breakdown.signals.length,
    `${externalId}: one row per signal — ${String(rendered.signals.length)} rendered vs ${String(trust.breakdown.signals.length)} returned`,
  );
  check(
    rendered.excluded.length === trust.breakdown.excluded.length,
    `${externalId}: every excluded signal is shown with its reason — ${String(rendered.excluded.length)} of ${String(trust.breakdown.excluded.length)}`,
  );
  check(
    rendered.signals.every((s) => s.points !== '' && s.weight !== ''),
    `${externalId}: every row carries its weight and its points, not just a name`,
  );
  check(
    rendered.pointsTotal.some((t) => t === trust.breakdown.pointsTotal.toFixed(2)),
    `${externalId}: the points total the API computed is on screen (${String(trust.breakdown.pointsTotal)})`,
  );
  check(
    rendered.badges.length >= 3,
    `${externalId}: trust, catalogue presence and health are three separate badges — ${rendered.badges.join(' | ')}`,
  );
  check(rendered.hasHealth, `${externalId}: the latest health check is rendered`);
  check(rendered.hasPreview, `${externalId}: the live-preview button is present and disabled (D3-07)`);

  for (const item of rendered.excluded) {
    console.log(`      excluded · ${item.text}`);
  }

  await screenshot(cdp, path.join(SHOTS, `d1-08-drawer-${externalId}.png`));

  // A second shot scrolled to the breakdown: the badges at the top are the summary, but the table
  // of signals is the claim the deck actually needs to show.
  await cdp.evaluate(
    `document.querySelector('[data-testid="trust-breakdown"]').scrollIntoView({ block: 'start' }); true`,
  );
  await new Promise((r) => setTimeout(r, 400));
  await screenshot(cdp, path.join(SHOTS, `d1-08-breakdown-${externalId}.png`));
}

await cdp.close();
console.log('');
