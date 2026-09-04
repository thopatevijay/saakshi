/**
 * `npm run trust:recompute`
 *
 * Scores health checks and writes the result to both places it belongs:
 *
 *  - `camera_health_checks.trust_score` + the scoring detail merged into `breakdown` — per check,
 *    which is what makes the 7-day trend possible at all;
 *  - `cameras.trust_score` — the current value, which is what the registry, the map (D1-08) and the
 *    gap analysis (D3-06) read.
 *
 * It exists because the scorer is TypeScript and the prober is Python: D1-05 writes `trust_score`
 * NULL on purpose ("a placeholder would be a number nobody computed") and something has to close
 * the loop. Mirrors D1-04's `sync:catalogue` precedent rather than inventing a new shape.
 */
import 'dotenv/config';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { cameraHealthChecks, cameras } from '@saakshi/shared/db';
import { loadEnv } from '../env.js';
import { createDb, createSql, type Db } from '../db/client.js';
import { loadWeights, score, signalsFromRow, type TrustWeights } from '../services/trust.js';

export interface RecomputeReport {
  checksScored: number;
  camerasUpdated: number;
  bands: Record<string, number>;
  weightsVersion: number;
}

/**
 * Scores every health check, or only the unscored ones.
 *
 * `--all` re-scores history, which is the operation you want after changing a weight: the AC is
 * that a weight change alters scores, and a trend that mixes two weight versions is a trend nobody
 * can read. `breakdown.trust.weightsVersion` records which version produced each row.
 */
export async function recompute(
  db: Db,
  options: { rescoreAll?: boolean; weights?: TrustWeights } = {},
): Promise<RecomputeReport> {
  const weights = options.weights ?? loadWeights();

  const rows = await db
    .select({
      cameraId: cameraHealthChecks.cameraId,
      checkedAt: cameraHealthChecks.checkedAt,
      connectable: cameraHealthChecks.connectable,
      decodable: cameraHealthChecks.decodable,
      measuredFps: cameraHealthChecks.measuredFps,
      blurScore: cameraHealthChecks.blurScore,
      lumaMean: cameraHealthChecks.lumaMean,
      tamperScore: cameraHealthChecks.tamperScore,
      ptsDriftMs: cameraHealthChecks.ptsDriftMs,
      breakdown: cameraHealthChecks.breakdown,
    })
    .from(cameraHealthChecks)
    .where(options.rescoreAll === true ? undefined : isNull(cameraHealthChecks.trustScore));

  const bands: Record<string, number> = {};
  let checksScored = 0;

  for (const row of rows) {
    const result = score(signalsFromRow(row), weights);

    await db
      .update(cameraHealthChecks)
      .set({
        trustScore: result.score,
        // Merged, not replaced: D1-05's measurement provenance is what makes the score auditable,
        // and overwriting it would leave a score nobody could trace back to a measurement.
        breakdown: sql`${cameraHealthChecks.breakdown} || ${JSON.stringify({
          trust: {
            score: result.score,
            band: result.band,
            weightsVersion: result.weightsVersion,
            signals: result.signals,
            excluded: result.excluded,
          },
        })}::jsonb`,
      })
      .where(
        and(
          eq(cameraHealthChecks.cameraId, row.cameraId),
          eq(cameraHealthChecks.checkedAt, row.checkedAt),
        ),
      );

    checksScored += 1;
  }

  // The camera's current score is its most recent check's, not an average: "how is this camera
  // right now" is the question the map and the gap analysis ask.
  const latest = db.$with('latest').as(
    db
      .selectDistinctOn([cameraHealthChecks.cameraId], {
        cameraId: cameraHealthChecks.cameraId,
        trustScore: cameraHealthChecks.trustScore,
        connectable: cameraHealthChecks.connectable,
      })
      .from(cameraHealthChecks)
      .orderBy(cameraHealthChecks.cameraId, desc(cameraHealthChecks.checkedAt)),
  );

  const updated = await db
    .with(latest)
    .update(cameras)
    .set({ trustScore: sql`${latest.trustScore}`, updatedAt: sql`now()` })
    .from(latest)
    .where(eq(cameras.id, latest.cameraId))
    .returning({ id: cameras.id, trustScore: cameras.trustScore });

  for (const row of updated) {
    const value = row.trustScore === null ? null : Number(row.trustScore);
    const band =
      value === null
        ? 'unscored'
        : value >= 70
          ? 'trusted'
          : value >= 40
            ? 'degraded'
            : 'untrusted';
    bands[band] = (bands[band] ?? 0) + 1;
  }

  return {
    checksScored,
    camerasUpdated: updated.length,
    bands,
    weightsVersion: weights.version,
  };
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const env = loadEnv();
  const rawSql = createSql(env.DATABASE_URL, 4);
  const db = createDb(rawSql);
  const rescoreAll = process.argv.includes('--all');

  try {
    const report = await recompute(db, { rescoreAll });
    console.log('');
    console.log(`  checks scored     ${String(report.checksScored)}`);
    console.log(`  cameras updated   ${String(report.camerasUpdated)}`);
    console.log(`  weights version   ${String(report.weightsVersion)}`);
    for (const [band, count] of Object.entries(report.bands).sort()) {
      console.log(`  ${band.padEnd(17)} ${String(count)}`);
    }
    console.log('');
  } finally {
    await rawSql.end();
  }
}
