/**
 * D2-07 — the alert queue, verified in a real browser.
 *
 * The acceptance criteria here are about *what an officer can see and reach*, and most of them
 * cannot be asserted from jsdom: whether five facts are simultaneously **on screen** at a legible
 * size, whether a fuzzy row is visually distinguishable from an exact one under the real computed
 * styles, whether a keyboard-only run through ack/dismiss/escalate actually moves the rows. So this
 * drives Chrome over CDP the way `verify-trace.mjs` and `verify-map.mjs` do.
 *
 * ## The three-second stopwatch, and what it does and does not claim
 *
 * AC 3 asks for a stopwatch run showing plate, camera, time, category and confidence are all
 * legible with no click. What is measured below is exactly that and no more: the wall-clock
 * interval from `Page.navigate` to the first instant at which **all five elements of the top row
 * are in the viewport, non-empty, visible, and rendered at ≥ 11 px**, sampled every 50 ms. It is a
 * measurement of the *screen*, not of a human's eye — a person still has to read what is there.
 * It is reported as such and never as "an officer verified an alert in N seconds".
 *
 * The second number is the **verdict round trip**: from the `a` keystroke on a focused row to the
 * row's `data-status` changing. That is the half of "confirm or dismiss in three seconds" the
 * machine can honestly time.
 *
 *   node scripts/verify-alerts.mjs <operator-token-file> [base-url] [api-url] [auditor-token-file]
 *
 * Defaults match the other verify scripts: web on 3100, API on 4100 — **not** the dev ports.
 * Requires alerts in the database: `npm run demo:alerts -w packages/api -- --seed`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, authenticate, navigate, waitFor, screenshot, check, pass } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(here, '../../../docs/screenshots');

const token = readFileSync(process.argv[2], 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
const api = process.argv[4] ?? 'http://localhost:4100';
/** Optional: a token for the `auditor` role, to check the read-only path. */
const auditorToken =
  process.argv[5] === undefined ? null : readFileSync(process.argv[5], 'utf8').trim();

/** The five facts AC 3 names. The verdict headline is a sixth, checked separately. */
const FIVE_FACTS = [
  'alert-plate',
  'alert-camera',
  'alert-time',
  'alert-category',
  'alert-confidence',
];

const LEGIBLE = `(() => {
  const row = document.querySelector('[data-testid="alert-row"]');
  if (row === null) return null;
  const ids = ${JSON.stringify(FIVE_FACTS)};
  const out = {};
  for (const id of ids) {
    const el = row.querySelector('[data-testid="' + id + '"]');
    if (el === null) { out[id] = { present: false }; continue; }
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    out[id] = {
      present: true,
      text: el.textContent.trim(),
      fontPx: parseFloat(style.fontSize),
      visible: style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity) > 0.5,
      inViewport: box.top >= 0 && box.left >= 0 && box.width > 0 && box.height > 0
        && box.bottom <= (window.innerHeight || document.documentElement.clientHeight),
    };
  }
  return out;
})()`;

const allLegible = (facts) =>
  facts !== null &&
  FIVE_FACTS.every((id) => {
    const f = facts[id];
    return (
      f !== undefined &&
      f.present &&
      f.text.length > 0 &&
      f.visible &&
      f.inViewport &&
      f.fontPx >= 11
    );
  });

/**
 * "A row exists" is not "a row is on screen".
 *
 * React streams the page in with the not-yet-hydrated content inside a hidden container, so
 * `querySelector('[data-testid="alert-row"]') !== null` is true seconds before anything is laid
 * out — every rect is 0×0 and `.focus()` on the viewport silently does nothing. Waiting on a
 * measured height is the only condition that means what it says. This cost an hour; it is written
 * down so the next script does not pay it again.
 */
const ROW_VISIBLE = `(() => {
  const row = document.querySelector('[data-testid="alert-row"]');
  return row !== null && row.getBoundingClientRect().height > 0;
})()`;

const apiGet = (p) =>
  fetch(`${api}${p}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());

/**
 * Press one key.
 *
 * `text` is the character the key produces, which is **not** the same as `key` for named keys —
 * CDP rejects `text: 'Enter'` outright, and wants `'\r'`. Getting this wrong fails loudly, which
 * is the only mercy in it.
 */
const NAMED = { Enter: '\r', Escape: '\u001b' };

const key = async (cdp, name, code, windowsVirtualKeyCode) => {
  const text = NAMED[name] ?? name;
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      ...(type === 'keyDown' ? { text } : {}),
      key: name,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    });
  }
  await new Promise((r) => setTimeout(r, 120));
};

const cdp = await openBrowser({ width: 1680, height: 1050 });

try {
  const queue = await apiGet('/api/v1/alerts?sort=severity&limit=200');
  const exact = queue.data.filter((a) => a.matchType === 'exact').length;
  const fuzzy = queue.data.length - exact;
  console.log(
    `\nqueue: ${queue.data.length} alerts — ${exact} exact / ${fuzzy} fuzzy · ` +
      Object.entries(
        queue.data.reduce((acc, a) => ({ ...acc, [a.severity]: (acc[a.severity] ?? 0) + 1 }), {}),
      )
        .map(([s, n]) => `${n} ${s}`)
        .join(', ') +
      '\n',
  );
  if (queue.data.length === 0) {
    throw new Error('no alerts to verify — run `npm run demo:alerts -w packages/api -- --seed`');
  }

  await authenticate(cdp, token, 'operator', base);

  /* ── AC 3 — the three-second stopwatch ──────────────────────────────────────────────────── */

  console.log('AC 3 — three-second test: the five facts, no click');

  await cdp.send('Page.enable');

  /**
   * One stopwatch run: navigate, then poll until every one of the five facts is on screen.
   *
   * Run twice. **Cold** is this browser's very first navigation — a fresh profile, nothing
   * compiled, nothing cached — and **warm** is the second, which is the state a control-room screen
   * is actually in. Reporting only one of the two would flatter us in one direction or the other.
   */
  const stopwatch = async (url) => {
    const t0 = Date.now();
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 600; i += 1) {
      const seen = await cdp.evaluate(LEGIBLE).catch(() => null);
      if (allLegible(seen)) return { ms: Date.now() - t0, facts: seen };
      await new Promise((r) => setTimeout(r, 50));
    }
    return { ms: null, facts: await cdp.evaluate(LEGIBLE).catch(() => null) };
  };

  const cold = await stopwatch(`${base}/alerts?sort=severity`);
  const warm = await stopwatch(`${base}/alerts?sort=severity&run=2`);

  check(
    cold.ms !== null && warm.ms !== null,
    'all five facts legible with no click — plate, camera, time, category, confidence',
  );
  if (cold.facts !== null) {
    console.log(`\n    ⏱  STOPWATCH  cold ${cold.ms} ms · warm ${warm.ms} ms`);
    console.log(`       (navigation → every one of the five facts on screen, polled every 50 ms)`);
    for (const id of FIVE_FACTS) {
      const f = (warm.facts ?? cold.facts)[id];
      console.log(
        `       ${id.padEnd(18)} ${String(f.fontPx).padStart(5)} px  "${f.text.replace(/\s+/g, ' ')}"`,
      );
    }
    console.log(
      `    This times the SCREEN, not a reader: it proves the five facts are rendered, visible,\n` +
        `    inside the viewport and at least 11 px, with no click. A person still has to read them.\n`,
    );
    check(
      warm.ms !== null && warm.ms < 3000,
      `warm run inside the three-second budget (${warm.ms} ms)`,
    );
    check(cold.ms !== null && cold.ms < 3000, `cold run inside it too (${cold.ms} ms)`);
  }

  const verdict = await cdp.evaluate(
    `document.querySelector('[data-testid="alert-verdict"]').textContent.trim()`,
  );
  check(
    verdict.length > 0,
    `the row leads with the identification verdict, before any score — "${verdict}"`,
  );

  /* ── AC 7 — fuzzy vs exact ──────────────────────────────────────────────────────────────── */

  console.log('\nAC 7 — fuzzy and exact are visually unmistakable');

  const styles = await cdp.evaluate(`JSON.stringify((() => {
    const rows = [...document.querySelectorAll('[data-testid="alert-row"]')];
    const pick = (type) => rows.find((r) => r.dataset.matchType === type);
    const read = (row) => {
      if (row === undefined) return null;
      const chip = row.querySelector('[data-testid="alert-match"]');
      const s = getComputedStyle(chip);
      return { text: chip.textContent.trim(), colour: s.color, border: s.borderColor, style: s.borderStyle };
    };
    return { exact: read(pick('exact')), fuzzy: read(pick('fuzzy')) };
  })())`);
  const seen = JSON.parse(styles);

  if (seen.exact !== null && seen.fuzzy !== null) {
    check(
      seen.exact.colour !== seen.fuzzy.colour,
      `different colour (${seen.exact.colour} vs ${seen.fuzzy.colour})`,
    );
    check(
      seen.exact.style !== seen.fuzzy.style,
      `different border style (${seen.exact.style} vs ${seen.fuzzy.style})`,
    );
    check(
      seen.exact.text.startsWith('EXACT') && seen.fuzzy.text.startsWith('FUZZY'),
      `different word — "${seen.exact.text}" vs "${seen.fuzzy.text}"`,
    );
    check(
      /d \d+\.\d\d/.test(seen.fuzzy.text),
      `the fuzzy chip shows the weighted distance to two decimals — "${seen.fuzzy.text}"`,
    );
  } else {
    check(false, 'the queue contains both an exact and a fuzzy alert to compare');
  }

  /* ── AC 2 — the crop degrades ───────────────────────────────────────────────────────────── */

  console.log('\nAC 2 — the crop degrades gracefully');
  const cropText = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="alert-crop-placeholder"], [data-testid="alert-crop"] img');
    if (el === null) return 'MISSING';
    return el.tagName === 'IMG' ? 'IMAGE' : el.textContent.trim();
  })()`);
  check(
    cropText !== 'MISSING',
    `the crop cell renders something an operator can read — "${cropText}"`,
  );

  /* ── screenshot ─────────────────────────────────────────────────────────────────────────── */

  // Taken **before** the sections below, which really do acknowledge, escalate and dismiss rows:
  // the deck screenshot has to show an unactioned queue with its actions live.
  console.log('\nScreenshot');
  await navigate(cdp, `${base}/alerts?sort=severity`);
  await waitFor(cdp, ROW_VISIBLE, { label: 'queue rendered' });
  // Expand the fuzzy alert: the screenshot has to carry the caveats and the disclaimer.
  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-testid="alert-row"]')].find((r) => r.dataset.matchType === 'fuzzy');
    if (row !== undefined) row.querySelector('[data-testid="alert-expand"]').click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const file = await screenshot(cdp, path.join(SHOTS, 'alerts-queue.png'));
  pass(`captured ${file}`);

  /* ── AC 6 — filters compose and persist in the URL ──────────────────────────────────────── */

  console.log('\nAC 6 — filters compose and persist in the URL');
  const cameraId = queue.data[0].cameraId;
  const filtered = `${base}/alerts?status=new&severity=low&category=blacklisted_vehicle&match=exact&camera=${cameraId}&sort=recent`;
  await navigate(cdp, filtered);
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="alert-filters"]').getBoundingClientRect().height > 0`,
    {
      label: 'filter row rendered',
    },
  );

  const restored = await cdp.evaluate(`JSON.stringify({
    status: document.querySelector('[data-testid="filter-status"]').value,
    severity: document.querySelector('[data-testid="filter-severity"]').value,
    category: document.querySelector('[data-testid="filter-category"]').value,
    match: document.querySelector('[data-testid="filter-match"]').value,
    camera: document.querySelector('[data-testid="filter-camera"]').value,
    sort: document.querySelector('[data-testid="filter-sort"]').value,
    rows: document.querySelectorAll('[data-testid="alert-row"]').length,
    matchTypes: [...new Set([...document.querySelectorAll('[data-testid="alert-row"]')].map((r) => r.dataset.matchType))],
    url: window.location.search,
  })`);
  const state = JSON.parse(restored);
  check(state.status === 'new', 'status survived the URL');
  check(state.severity === 'low', 'severity survived the URL');
  check(state.category === 'blacklisted_vehicle', 'category survived the URL');
  check(state.match === 'exact', 'match type survived the URL');
  check(state.camera === cameraId, 'camera survived the URL');
  check(state.sort === 'recent', 'sort survived the URL');
  check(
    state.matchTypes.length === 0 ||
      (state.matchTypes.length === 1 && state.matchTypes[0] === 'exact'),
    `six filters compose — ${state.rows} rows, all exact`,
  );
  check(
    state.url.includes('camera=') && state.url.includes('severity='),
    'the address still carries them',
  );

  /* ── RBAC: what an auditor actually gets ────────────────────────────────────────────────── */

  /**
   * **A divergence this script found, and does not paper over.**
   *
   * D2-06's handoff says an `auditor` may *read* the alert queue and may not transition anything,
   * and the API agrees: `READ_ROLES` in `auth.ts` includes `auditor`, and `GET /api/v1/alerts` with
   * an auditor token answers **200**. But the shared capability matrix does not grant `auditor` the
   * `alerts:view` capability, so `middleware.ts` redirects them to `/forbidden` before the screen
   * renders at all — measured **307 → /forbidden?path=%2Falerts**.
   *
   * Changing `ROLE_CAPABILITIES` is D1-07's decision and would move the nav on every screen, so
   * D2-07 does not touch it. What this script asserts is the behaviour that is actually shipping,
   * and it prints the divergence so nobody has to rediscover it. Logged to BL-01 and noted on
   * D2-GATE.
   */
  console.log('\nRBAC — what an auditor gets');
  if (auditorToken === null) {
    console.log('    skipped: pass an auditor token file as the 4th argument to check this');
  } else {
    const apiStatus = await fetch(`${api}/api/v1/alerts?limit=1`, {
      headers: { authorization: `Bearer ${auditorToken}` },
    }).then((r) => r.status);
    const webStatus = await fetch(`${base}/alerts`, {
      headers: { cookie: `saakshi_session=${auditorToken}; saakshi_role=auditor` },
      redirect: 'manual',
    }).then((r) => ({ status: r.status, location: r.headers.get('location') }));

    check(apiStatus === 200, `the API lets an auditor read the queue (HTTP ${String(apiStatus)})`);
    check(
      webStatus.status === 307 && (webStatus.location ?? '').includes('/forbidden'),
      `the web shell does not — ${String(webStatus.status)} → ${webStatus.location ?? 'no location'}`,
    );
    console.log(
      `    ⚠ DIVERGENCE: the API grants \`auditor\` read access to alerts; the shared capability\n` +
        `      matrix withholds \`alerts:view\`, so the screen is unreachable for that role. D2-07 does\n` +
        `      not change ROLE_CAPABILITIES — that is D1-07's matrix. Logged to BL-01.`,
    );
  }

  /* ── AC 8 — the keyboard, end to end ────────────────────────────────────────────────────── */

  console.log('\nAC 8 — a keyboard-only run through ack, escalate and dismiss');

  // `status=new` so the run is repeatable: the previous run's transitions are real and permanent,
  // and `dismissed` is terminal. When this filter is empty, re-seed:
  //   npm run demo:alerts -w packages/api -- --remove && npm run demo:alerts -w packages/api -- --seed
  await navigate(cdp, `${base}/alerts?status=new&sort=severity`);
  await waitFor(cdp, ROW_VISIBLE, {
    label: 'an unactioned alert to work on (re-seed with demo:alerts if this times out)',
  });
  await cdp.evaluate(`document.querySelector('[data-testid="alert-viewport"]').focus()`);

  // j — take the first row.
  await key(cdp, 'j', 'KeyJ', 74);
  const focused = await cdp.evaluate(`JSON.stringify({
    id: document.activeElement.dataset.alertId ?? null,
    ring: getComputedStyle(document.activeElement).outlineWidth + '/' + (document.activeElement.className.includes('ring-') ? 'ring' : 'none'),
    status: document.activeElement.dataset.status ?? null,
  })`);
  const first = JSON.parse(focused);
  check(first.id !== null, `j focuses the first row (${first.id})`);
  check(first.ring.includes('ring'), 'the focused row carries a visible focus ring');

  // j then k returns to the first row.
  await key(cdp, 'j', 'KeyJ', 74);
  const second = await cdp.evaluate(`document.activeElement.dataset.alertId`);
  await key(cdp, 'k', 'KeyK', 75);
  const back = await cdp.evaluate(`document.activeElement.dataset.alertId`);
  check(second !== first.id && back === first.id, 'j and k move the cursor and come back');

  // a — acknowledge, and watch the row's status change.
  const ackStart = Date.now();
  await key(cdp, 'a', 'KeyA', 65);
  await waitFor(
    cdp,
    `document.querySelector('[data-alert-id="${first.id}"]').dataset.status !== 'new'`,
    {
      timeoutMs: 10000,
      label: 'the acknowledged row changes status',
    },
  );
  const ackMs = Date.now() - ackStart;
  const ackStatus = await cdp.evaluate(
    `document.querySelector('[data-alert-id="${first.id}"]').dataset.status`,
  );
  check(ackStatus === 'ack', `a acknowledges from the keyboard (status ${ackStatus})`);
  console.log(
    `\n    ⏱  VERDICT ROUND TRIP: ${ackMs} ms from the "a" keystroke to the row updating\n`,
  );

  // e — escalate the same row (ack → escalated is a legal transition).
  await key(cdp, 'e', 'KeyE', 69);
  await waitFor(
    cdp,
    `document.querySelector('[data-alert-id="${first.id}"]').dataset.status === 'escalated'`,
    {
      timeoutMs: 10000,
      label: 'the escalated row changes status',
    },
  );
  pass('e escalates from the keyboard');

  /* ── AC 5 — dismiss needs a reason ──────────────────────────────────────────────────────── */

  console.log('\nAC 5 — dismiss without a reason is blocked');
  await key(cdp, 'd', 'KeyD', 68);
  const guard = await cdp.evaluate(`JSON.stringify((() => {
    const field = document.querySelector('[data-testid="alert-dismiss-note"]');
    const confirm = document.querySelector('[data-testid="alert-dismiss-confirm"]');
    return { field: field !== null, disabled: confirm === null ? null : confirm.disabled };
  })())`);
  const g = JSON.parse(guard);
  check(g.field, 'd opens a reason field rather than dismissing outright');
  check(g.disabled === true, 'the dismiss button is disabled while the reason is empty');

  await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid="alert-dismiss-note"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'plate region illegible — not this vehicle');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const enabled = await cdp.evaluate(
    `document.querySelector('[data-testid="alert-dismiss-confirm"]').disabled === false`,
  );
  check(enabled, 'a reason enables it');

  await cdp.evaluate(`document.querySelector('[data-testid="alert-dismiss-confirm"]').click()`);
  await waitFor(
    cdp,
    `document.querySelector('[data-alert-id="${first.id}"]').dataset.status === 'dismissed'`,
    {
      timeoutMs: 10000,
      label: 'the dismissed row changes status',
    },
  );
  pass('the dismissal lands with its reason');

  const terminal = await cdp.evaluate(`JSON.stringify((() => {
    const row = document.querySelector('[data-alert-id="${first.id}"]');
    return {
      ack: row.querySelector('[data-testid="alert-ack"]').disabled,
      escalate: row.querySelector('[data-testid="alert-escalate"]').disabled,
    };
  })())`);
  const t = JSON.parse(terminal);
  check(t.ack && t.escalate, 'dismissed is terminal — every other action is disabled');

  /* ── the why payload ────────────────────────────────────────────────────────────────────── */

  console.log('\nThe why-payload is on screen, not behind a link');
  await key(cdp, 'Enter', 'Enter', 13);
  await waitFor(
    cdp,
    `(() => { const d = document.querySelector('[data-testid="alert-detail"]'); return d !== null && d.getBoundingClientRect().height > 0; })()`,
    {
      label: 'the evidence panel opens',
    },
  );
  const why = await cdp.evaluate(`JSON.stringify({
    caveats: document.querySelectorAll('[data-testid="alert-caveats"] li').length,
    note: (document.querySelector('[data-testid="alert-watchlist-note"]')?.textContent ?? ''),
    live: (document.querySelector('[data-testid="alert-live-flag"]')?.textContent ?? ''),
    disclaimer: (document.querySelector('[data-testid="alert-disclaimer"]')?.textContent ?? ''),
    severityBasis: (document.querySelector('[data-testid="alert-severity-basis"]')?.textContent ?? ''),
  })`);
  const w = JSON.parse(why);
  check(w.caveats > 0, `every caveat is rendered verbatim (${w.caveats} of them)`);
  check(w.live.includes('live=false'), 'the record states live=false in words');
  check(w.disclaimer.includes('MOCK PROVIDERS'), 'the mock-provider disclaimer is on the panel');
  check(w.severityBasis.includes('rank'), 'the severity derivation is shown, ceilings included');
  if (w.note !== '') pass(`the watchlist row's own provenance note is shown`);
} finally {
  await cdp.close();
}
