/**
 * Lighthouse accessibility audit — the acceptance criterion, as a repeatable command.
 *
 *   node scripts/a11y.mjs <path-to-token-file> [base-url] [role]
 *
 * "Accessibility ≥ 90 on the login and shell routes" is only meaningful if somebody can re-run it,
 * so it is a script rather than a number pasted into a PR once. The shell route needs a session, so
 * the caller supplies a bearer token to set as the cookie.
 *
 * Requires the web app and API to be running; the defaults are the dev ports (:3000 / :4000), and
 * the verification ports (:3100 / :4100) can be passed as the second argument.
 */
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { readFileSync } from 'node:fs';

const THRESHOLD = 90;
const tokenFile = process.argv[2];
const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '';

const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox'] });

const base = process.argv[3] ?? 'http://localhost:3000';
const role = process.argv[4] ?? 'admin';

const targets = [
  { name: 'login', url: `${base}/login`, authenticated: false },
  { name: 'shell (/registry)', url: `${base}/registry`, authenticated: true },
  { name: 'forbidden', url: `${base}/forbidden`, authenticated: false },
  // D2-07: the alert queue is keyboard-first and is the screen an operator stares at for a shift,
  // so its accessibility score is an acceptance criterion rather than a nicety.
  { name: 'alerts', url: `${base}/alerts`, authenticated: true },
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
    options.extraHeaders = { Cookie: `saakshi_session=${token}; saakshi_role=${role}` };
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
