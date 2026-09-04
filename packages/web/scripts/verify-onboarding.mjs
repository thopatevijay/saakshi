/**
 * AC 6 — "Bulk import from the UI succeeds with the 50-row fixture and shows the row-level error
 * report for the invalid fixture."
 *
 * Driven through the **real dialog in a real browser**, not by calling the API: the criterion is
 * about the UI, and an assertion against `POST /api/v1/cameras/bulk` would prove D1-02 works, which
 * D1-02 already proved. What is untested until you push the button is whether the file input, the
 * server action, the multipart re-encoding and the rejection table actually line up.
 *
 *   node scripts/verify-onboarding.mjs <token-file> [base-url]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { authenticate, check, navigate, openBrowser, screenshot, waitFor } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const FIXTURES = path.join(repoRoot, 'fixtures');
const SHOTS = path.join(repoRoot, 'docs/screenshots');

const token = readFileSync(process.argv[2], 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';

const cdp = await openBrowser();
await authenticate(cdp, token, 'admin', base);
await cdp.send('DOM.enable');
await cdp.send('Runtime.enable');

/** Open the import dialog, attach a file, submit, and read the report back off the DOM. */
async function importFile(file) {
  await navigate(cdp, `${base}/registry`);
  await waitFor(cdp, `!!document.querySelector('[data-action="bulk-import"]')`, {
    label: 'the bulk import button',
  });
  // Click inside the poll: the button exists in the server HTML before React has hydrated, and a
  // click that lands in that window is swallowed with no error and no dialog.
  await waitFor(
    cdp,
    `(() => {
      if (document.querySelector('[data-testid="import-file"]')) return true;
      document.querySelector('[data-action="bulk-import"]')?.click();
      return false;
    })()`,
    { label: 'the import dialog to open' },
  );

  // The file input is a real one; CDP attaches to it exactly as a user's file picker would.
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
    timeoutMs: 60000,
    label: 'the import report',
  });

  return cdp.evaluate(`(() => {
    const read = (k) => Number(document.querySelector('[data-report="' + k + '"]').textContent);
    const rows = [...document.querySelectorAll('[data-rejected-row]')].map((tr) => ({
      row: Number(tr.getAttribute('data-rejected-row')),
      problems: [...tr.querySelectorAll('li')].map((li) => li.textContent.trim()),
    }));
    return {
      received: read('received'),
      imported: read('imported'),
      created: read('created'),
      updated: read('updated'),
      rejected: read('rejected'),
      rows,
    };
  })()`);
}

console.log('\nAC 6 · bulk import from the UI\n');

// ── The 50-row fixture ──────────────────────────────────────────────────────────────────────────
const valid = await importFile(path.join(FIXTURES, 'cameras-bulk-sample.csv'));
console.log(`  valid fixture   ${JSON.stringify(valid)}`);
check(valid.received === 50, `the dialog read all 50 rows (received ${String(valid.received)})`);
check(valid.imported === 50, `all 50 rows imported (imported ${String(valid.imported)})`);
check(valid.rejected === 0, 'no row was rejected');
await screenshot(cdp, path.join(SHOTS, 'd1-08-import-success.png'));

// ── The invalid fixture ─────────────────────────────────────────────────────────────────────────
const invalid = await importFile(path.join(FIXTURES, 'cameras-bulk-invalid.csv'));
console.log(`  invalid fixture ${JSON.stringify({ ...invalid, rows: invalid.rows.length })}`);
check(invalid.imported === 47, `47 valid rows still committed (imported ${String(invalid.imported)})`);
check(invalid.rejected === 3, `3 rows rejected (rejected ${String(invalid.rejected)})`);
check(
  invalid.rows.length === 3,
  `every rejection is rendered with its row number, not just counted (${String(invalid.rows.length)} rows in the table)`,
);
for (const row of invalid.rows) {
  check(
    row.problems.length > 0,
    `row ${String(row.row)} names the field that failed — ${row.problems.join('; ')}`,
  );
}
await screenshot(cdp, path.join(SHOTS, 'd1-08-import-errors.png'));

// ── Idempotence, which is what makes the round trip in AC 7 possible ────────────────────────────
const again = await importFile(path.join(FIXTURES, 'cameras-bulk-sample.csv'));
check(
  again.created === 0 && again.updated === 50,
  `re-importing the same file updates rather than duplicates (created ${String(again.created)}, updated ${String(again.updated)})`,
);

await cdp.close();
console.log('');
