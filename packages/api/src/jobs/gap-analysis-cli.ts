/**
 * `npm run report:gap-analysis [-- --out docs] [--limit 25] [--json]`
 *
 * Recomputes `camera_coverage` for the whole live estate, runs the coverage arithmetic, and writes
 * `docs/gap-analysis-sample.md` and `docs/gap-analysis-sample.pdf` — the Model 1 deliverable.
 *
 * Two things this deliberately refuses to do:
 *
 * - **Publish an unreconciled report.** If `covered + uncovered` misses the candidate ways' own
 *   length by more than `RECONCILE_TOLERANCE_M`, it exits non-zero and writes nothing. A gap
 *   analysis whose kilometres do not add up is worse than none.
 * - **Fill in a missing estate.** With no roads or no placed cameras it says so and stops, rather
 *   than emitting a report full of well-formatted zeroes that reads as a finding.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, createSql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { analyse, RECONCILE_TOLERANCE_M } from '../services/coverage.js';
import { gapAnalysisMarkdown, gapAnalysisPdf } from '../services/gap-report.js';

function flag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  if (index !== -1) return args[index + 1];
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

/**
 * The repository root from this file, never `process.cwd()`: `npm run report:gap-analysis` from the
 * root re-enters the workspace, so the working directory is `packages/api` by the time this runs.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const outFlag = flag('out');
const outDir = outFlag === undefined ? path.join(REPO_ROOT, 'docs') : path.resolve(outFlag);
const asJson = process.argv.includes('--json');

const env = loadEnv();
const rawSql = createSql(env.DATABASE_URL, 4);
const db = createDb(rawSql);

try {
  const started = Date.now();
  const analysis = await analyse(db);

  if (analysis.network.ways === 0) {
    console.error(
      'road_network is empty — nothing to compute coverage against. Run ./scripts/import-osm.sh ' +
        '(see docs/road-network-setup.md), then re-run this report.',
    );
    process.exit(1);
  }
  if (analysis.split.assessed === 0) {
    console.error(
      `No camera in this estate carries coordinates (${String(analysis.split.total)} registered, ` +
        '0 placed), so there is no spatial question to ask. Import a geolocated set through ' +
        'POST /api/v1/cameras/bulk first.',
    );
    process.exit(1);
  }

  const offenders = [analysis.all, analysis.trustedOnly, analysis.anprViable].filter(
    (s) => s.reconcileErrorM > RECONCILE_TOLERANCE_M,
  );
  if (offenders.length > 0) {
    for (const s of offenders) {
      console.error(
        `reconciliation failed for "${s.label}": covered + uncovered differs from the candidate ` +
          `ways' own length by ${s.reconcileErrorM.toFixed(4)} m, over the ` +
          `${String(RECONCILE_TOLERANCE_M)} m tolerance`,
      );
    }
    console.error('refusing to write a report whose kilometres do not add up');
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, 'gap-analysis-sample.md');
  const pdfPath = path.join(outDir, 'gap-analysis-sample.pdf');
  writeFileSync(mdPath, gapAnalysisMarkdown(analysis), 'utf8');
  writeFileSync(pdfPath, gapAnalysisPdf(analysis));

  if (asJson) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    const rel = (p: string): string => path.relative(REPO_ROOT, p);
    console.log(`database        ${analysis.databaseName}`);
    console.log(
      `estate          ${String(analysis.split.total)} cameras · ` +
        `${String(analysis.split.assessed)} assessed · ` +
        `${String(analysis.split.unassessable)} unassessable (no coordinates)`,
    );
    console.log(
      `camera_coverage ${String(analysis.write.rows)} rows · ` +
        `${String(analysis.write.withPolygon)} with a polygon · ` +
        `${String(analysis.write.unplaceable)} null geometry`,
    );
    console.log(
      `network         ${analysis.network.ways.toLocaleString('en-IN')} ways · ` +
        `${analysis.network.km.toFixed(1)} km`,
    );
    console.log(`all cameras     ${analysis.all.coveredKm.toFixed(4)} km covered`);
    console.log(`trusted only    ${analysis.trustedOnly.coveredKm.toFixed(4)} km covered`);
    console.log(
      `delta           ${analysis.deltaKm.toFixed(4)} km` +
        (analysis.deltaShare === null
          ? ''
          : ` (${(analysis.deltaShare * 100).toFixed(1)}% of apparent coverage)`),
    );
    console.log(
      `junctions       ${analysis.junctions.uncovered.toLocaleString('en-IN')} of ` +
        `${analysis.junctions.total.toLocaleString('en-IN')} with zero trusted coverage`,
    );
    console.log(
      `reconciliation  max error ${Math.max(
        analysis.all.reconcileErrorM,
        analysis.trustedOnly.reconcileErrorM,
        analysis.anprViable.reconcileErrorM,
      ).toFixed(6)} m (tolerance ${String(RECONCILE_TOLERANCE_M)} m)`,
    );
    console.log(`wrote           ${rel(mdPath)}`);
    console.log(`wrote           ${rel(pdfPath)}`);
    console.log(`elapsed         ${String(Date.now() - started)} ms`);
  }
} finally {
  await rawSql.end();
}
