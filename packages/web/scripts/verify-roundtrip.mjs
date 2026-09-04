/**
 * AC 7 — "Export downloads a valid CSV that re-imports cleanly (round-trip test)."
 *
 * The claim being tested is stronger than "the file parses". A registry a department cannot hand
 * back to itself is a one-way sink: the useful loop is *export → fix the wrong rows in a
 * spreadsheet → re-import*, and that only works if re-importing produces **updates, not
 * duplicates**. So the assertions are: the export is downloadable through the app with the
 * httpOnly session, it has the column header the importer expects, re-importing it through the real
 * UI dialog reports `created 0`, and `count(*)` in Postgres is unchanged afterwards.
 *
 * The download is fetched with `fetch` rather than driven through a headless browser's download
 * manager — same route handler, same cookie, same bytes, and no dependence on a download directory
 * that headless Chrome may or may not honour.
 *
 *   DATABASE_URL=… node scripts/verify-roundtrip.mjs <token-file> [base-url]
 */
import path from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { authenticate, check, navigate, openBrowser, waitFor } from './cdp.mjs';

const token = readFileSync(process.argv[2], 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const count = () =>
  Number(
    execFileSync(
      'psql',
      [databaseUrl, '-tAc', 'select count(*) from cameras where deleted_at is null'],
      { encoding: 'utf8' },
    ).trim(),
  );

const cookie = `saakshi_session=${token}; saakshi_role=admin`;

console.log('\nAC 7 · export → re-import round trip\n');

const before = count();

// ── Download, through the app's own route handler ───────────────────────────────────────────────
const response = await fetch(`${base}/registry/export?format=csv`, { headers: { cookie } });
const csv = await response.text();

check(response.status === 200, `the export responded 200 (${String(response.status)})`);
check(
  (response.headers.get('content-disposition') ?? '').includes('attachment'),
  `it is served as a download — ${String(response.headers.get('content-disposition'))}`,
);
check(
  (response.headers.get('content-type') ?? '').startsWith('text/csv'),
  `content-type is CSV — ${String(response.headers.get('content-type'))}`,
);

const lines = csv.trim().split('\n');
const header = lines[0];
console.log(`  ${String(lines.length - 1)} data rows · header: ${header}`);
check(
  lines.length - 1 === before,
  `the export contains every camera in the registry — ${String(lines.length - 1)} rows vs ${String(before)} in Postgres`,
);
check(
  header.startsWith('externalId,name,departmentId,lat,lon'),
  'the header matches the bulk-import column order, so the file is re-importable as written',
);

// Anonymous must not be able to pull the estate.
const anonymous = await fetch(`${base}/registry/export?format=csv`, { redirect: 'manual' });
check(
  anonymous.status === 307 || anonymous.status === 302 || anonymous.status === 401,
  `an unauthenticated export is refused, not served (HTTP ${String(anonymous.status)})`,
);

// JSON too — the other half of "CSV/JSON export".
const asJson = await fetch(`${base}/registry/export?format=json`, { headers: { cookie } });
const parsed = await asJson.json();
check(
  Array.isArray(parsed.cameras) && parsed.cameras.length === before,
  `the JSON export carries the same ${String(before)} cameras`,
);

// ── Re-import the exported file, through the real dialog ────────────────────────────────────────
const dir = mkdtempSync(path.join(tmpdir(), 'saakshi-roundtrip-'));
const file = path.join(dir, 'saakshi-cameras.csv');
writeFileSync(file, csv);

const cdp = await openBrowser();
await authenticate(cdp, token, 'admin', base);
await cdp.send('DOM.enable');

await navigate(cdp, `${base}/registry`);
await waitFor(
  cdp,
  `(() => {
    if (document.querySelector('[data-testid="import-file"]')) return true;
    document.querySelector('[data-action="bulk-import"]')?.click();
    return false;
  })()`,
  { label: 'the import dialog' },
);

const { root } = await cdp.send('DOM.getDocument');
const { nodeId } = await cdp.send('DOM.querySelector', {
  nodeId: root.nodeId,
  selector: '[data-testid="import-file"]',
});
await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
await cdp.evaluate(
  `document.querySelector('[data-testid="import-dialog"] button[type="submit"]').click(); true`,
);
await waitFor(cdp, `!!document.querySelector('[data-testid="import-report"]')`, {
  timeoutMs: 120000,
  label: 'the re-import report',
});

const report = await cdp.evaluate(`(() => {
  const read = (k) => Number(document.querySelector('[data-report="' + k + '"]').textContent);
  return JSON.stringify({
    received: read('received'),
    imported: read('imported'),
    created: read('created'),
    updated: read('updated'),
    rejected: read('rejected'),
  });
})()`).then(JSON.parse);

console.log(`  re-import: ${JSON.stringify(report)}`);
await cdp.close();

const after = count();

check(report.rejected === 0, `every exported row re-imported without a rejection`);
check(
  report.created === 0,
  `no row was created on re-import — the export round-trips as an update (created ${String(report.created)})`,
);
check(
  report.updated === before,
  `all ${String(before)} rows matched an existing camera (updated ${String(report.updated)})`,
);
check(
  after === before,
  `the registry is exactly the same size afterwards — zero duplicates (${String(before)} → ${String(after)})`,
);

console.log('');
