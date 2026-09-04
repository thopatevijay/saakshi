/**
 * Lighthouse accessibility audit — the acceptance criterion, as a repeatable command.
 *
 *   node scripts/a11y.mjs <path-to-token-file>
 *
 * "Accessibility ≥ 90 on the login and shell routes" is only meaningful if somebody can re-run it,
 * so it is a script rather than a number pasted into a PR once. The shell route needs a session, so
 * the caller supplies a bearer token to set as the cookie.
 *
 * Requires the web app on :3000 and the API on :4000.
 */
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { readFileSync } from 'node:fs';

const THRESHOLD = 90;
const tokenFile = process.argv[2];
const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '';

const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox'] });

const targets = [
  { name: 'login', url: 'http://localhost:3000/login', authenticated: false },
  { name: 'shell (/registry)', url: 'http://localhost:3000/registry', authenticated: true },
  { name: 'forbidden', url: 'http://localhost:3000/forbidden', authenticated: false },
];

let worst = 100;

for (const target of targets) {
  const options = {
    port: chrome.port,
    output: 'json',
    onlyCategories: ['accessibility'],
    logLevel: 'error',
  };
  if (target.authenticated) {
    options.extraHeaders = { Cookie: `saakshi_session=${token}; saakshi_role=admin` };
  }

  const result = await lighthouse(target.url, options);
  const category = result.lhr.categories.accessibility;
  const score = Math.round(category.score * 100);
  worst = Math.min(worst, score);

  console.log(`  ${target.name.padEnd(18)} accessibility ${String(score).padStart(3)}`);

  for (const ref of category.auditRefs) {
    const audit = result.lhr.audits[ref.id];
    if (ref.weight > 0 && audit?.score !== null && audit?.score < 1) {
      console.log(`      ✗ ${audit.id} — ${audit.title}`);
    }
  }
}

await chrome.kill();

console.log('');
if (worst < THRESHOLD) {
  console.error(
    `  FAIL: lowest score ${String(worst)} is below the ${String(THRESHOLD)} threshold`,
  );
  process.exit(1);
}
console.log(
  `  PASS: every route scores at least ${String(worst)} (threshold ${String(THRESHOLD)})`,
);
