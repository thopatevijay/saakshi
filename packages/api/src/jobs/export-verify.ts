/**
 * `npm run export:verify -- ./exports/<bundle>`
 *
 * Re-checks a bundle on disk. Exit 0 on a bundle that verifies, 1 on one that does not.
 *
 * This is the convenience path, for someone who has the repository. The bundle also carries its own
 * `verify.mjs`, which needs nothing but a Node runtime — and that is the one that matters, because
 * the person who most needs to check a bundle is the one who does not have the system that built it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyExportBundle } from '../services/export-bundle.js';

const target = process.argv.slice(2).find((a) => !a.startsWith('-'));
if (target === undefined) {
  console.error('usage: npm run export:verify -- ./exports/<bundle>');
  process.exit(2);
}

/**
 * `npm run export:verify` from the repository root re-enters the workspace, so `process.cwd()` is
 * `packages/api` by the time a relative path is resolved — and `./exports/<bundle>`, which is what
 * every instruction says to type, would resolve to a directory that does not exist. Try the working
 * directory first, then the repository root, so both spellings work.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fromCwd = path.resolve(target);
const resolved = existsSync(fromCwd) ? fromCwd : path.resolve(REPO_ROOT, target);

const result = await verifyExportBundle(resolved);

console.log(`bundle       ${result.bundleId ?? '(unreadable)'}`);
console.log(`path         ${result.dir}`);
console.log(`items        ${result.itemsChecked} verified`);
console.log(`bytes        ${result.bytesChecked}`);
console.log(`manifest     ${result.manifestHash ?? '(none)'}`);

if (result.ok) {
  console.log('\nPASS — every file matches the manifest, and the manifest matches its hash.');
  console.log(
    'This proves the bundle is unaltered since it was built. It does not prove the contents are\n' +
      'true: sightings are observed, identity links and the path between them are inferred.',
  );
  process.exit(0);
}

console.log(`\nFAIL — ${result.failures.length} problem(s):`);
for (const failure of result.failures) {
  console.log(`  ${failure.path}  [${failure.reason}]`);
  console.log(`    ${failure.detail}`);
  if (failure.expected !== undefined) console.log(`    expected ${failure.expected}`);
  if (failure.actual !== undefined) console.log(`    actual   ${failure.actual}`);
}
process.exit(1);
