/**
 * `npm run export:bundle -- --trace <registration> --case <FIR ref> [--purpose "..."] [--out ./exports]`
 *
 * Builds one evidence bundle for one vehicle and prints where it landed.
 *
 * **`--trace <id>` is the vehicle registration.** D2-08 keys a trace on the plate — there is no
 * trace id to pass, because a trace is not a stored object, it is a query answered on demand. The
 * flag is named `--trace` because that is what the ticket's validation gate calls it.
 *
 * **`--case` is mandatory, enforced here as well as in the API.** An export leaves the system, and
 * once evidence is in someone's hands "which case is this for" stops being answerable from the
 * inside. Omitting it is exit 2, not a prompt.
 *
 * `--purpose` defaults to a sentence naming the case, because a bundle built from the command line
 * still writes an audit entry and that entry still has to say why.
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, createSql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { TraceService } from '../services/trace.js';
import { presignerFromEnv } from '../services/crop-url.js';
import { buildExportBundle } from '../services/export-bundle.js';

function flag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  if (index !== -1) return args[index + 1];
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

/**
 * The repository root, derived from this file rather than from `process.cwd()`.
 *
 * `npm run export:bundle` from the root re-enters the workspace, so the process's working directory
 * is `packages/api` by the time this runs — and bundles would quietly land in
 * `packages/api/exports/` while every instruction, including the ticket's own validation gate, says
 * `./exports/`. An operator looking for their evidence in the documented place would not find it.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const plate = flag('trace') ?? flag('plate');
const caseRef = flag('case');
const outFlag = flag('out');
const outDir = outFlag === undefined ? path.join(REPO_ROOT, 'exports') : path.resolve(outFlag);

if (plate === undefined || plate.startsWith('--')) {
  console.error('usage: npm run export:bundle -- --trace <registration> --case <FIR/2026/00123>');
  process.exit(2);
}
if (caseRef === undefined || caseRef.startsWith('--')) {
  // The server-side rule, restated at the only other door into the bundle builder.
  console.error('refusing to export without a case reference: pass --case <FIR/2026/00123>');
  process.exit(2);
}

const purpose = flag('purpose') ?? `evidence export for ${caseRef}`;

const env = loadEnv();
const rawSql = createSql(env.DATABASE_URL, 4);
const db = createDb(rawSql);

try {
  const presign = presignerFromEnv();
  const trace = await new TraceService(db, undefined, presign).trace(plate);

  const built = await buildExportBundle({
    db,
    trace,
    purpose,
    caseRef,
    outDir,
    presign,
  });

  console.log(`bundle       ${built.bundleId}`);
  console.log(`path         ${built.dir}`);
  console.log(`case         ${caseRef}`);
  console.log(`subject      ${trace.normalized === '' ? trace.query : trace.normalized}`);
  console.log(`sightings    ${built.manifest.counts.sightings}`);
  console.log(`crops        ${built.manifest.counts.cropsIncluded} included, ${built.manifest.counts.cropsUnavailable} unavailable`);
  console.log(`items        ${built.manifest.items.length}`);
  console.log(`manifest     ${built.manifestHash}`);
  console.log(`audit entry  ${built.manifest.chain.auditEntryHash}`);
  if (built.manifest.counts.cropsUnavailable > 0) {
    console.log('\nCrops that could not be included, with the reason each is absent:');
    for (const omission of built.manifest.omissions) {
      console.log(`  seq ${omission.seq}  ${omission.cameraExternalId}  ${omission.reason}`);
    }
  }
  console.log(`\nVerify it with:  npm run export:verify -- ${built.dir}`);
  console.log(`Or, with nothing but node:  node ${built.dir}/verify.mjs`);
} finally {
  await rawSql.end();
}
