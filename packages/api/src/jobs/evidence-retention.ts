/**
 * `npm run evidence:retention [-- --check]`
 *
 * Applies `config/evidence-retention.json` to the evidence bucket as an S3 lifecycle configuration,
 * then reads the policy back **from the store** and prints what the store says it is.
 *
 * Read-back is the point. A retention policy that exists only in a config file is a promise; one
 * the object store reports is a fact, and Pillar 4 is about being able to tell an officer when
 * evidence expires without anyone having to trust a README.
 *
 *   npm run evidence:retention            # apply, then show what the bucket reports
 *   npm run evidence:retention -- --check # show only; change nothing
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceStoreFromEnv, type RetentionRule } from '../services/evidence.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH =
  process.env['EVIDENCE_RETENTION_CONFIG'] ??
  path.resolve(here, '../../../../config/evidence-retention.json');

export function loadRetentionRules(configPath: string = CONFIG_PATH): RetentionRule[] {
  const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('rules' in parsed)) {
    throw new Error(`${configPath} has no "rules" array`);
  }
  const { rules } = parsed;
  if (!Array.isArray(rules)) throw new Error(`${configPath}: "rules" is not an array`);
  return rules.map((rule: unknown) => {
    const r = rule as Partial<RetentionRule>;
    if (!r.id || !r.prefix || typeof r.retainDays !== 'number') {
      throw new Error(`${configPath}: every rule needs id, prefix and retainDays`);
    }
    const out: RetentionRule = {
      id: r.id,
      prefix: r.prefix,
      retainDays: r.retainDays,
      enabled: r.enabled ?? true,
    };
    if (r.note !== undefined) out.note = r.note;
    return out;
  });
}

async function main(): Promise<number> {
  const store = evidenceStoreFromEnv();
  if (store === null) {
    console.error('MINIO_ACCESS_KEY / MINIO_SECRET_KEY are not set — no bucket to configure.');
    return 2;
  }

  const check = process.argv.includes('--check');
  if (!check) {
    const rules = loadRetentionRules();
    await store.putRetention(rules);
    console.log(`applied ${String(rules.length)} rule(s) from ${CONFIG_PATH}`);
  }

  const live = await store.getRetention();
  console.log('');
  console.log(`  bucket ${store.bucket} — retention as the store reports it:`);
  if (live.length === 0) {
    console.log('    (no lifecycle configuration)');
  }
  for (const rule of live) {
    console.log(
      `    ${rule.id.padEnd(28)} ${rule.prefix.padEnd(24)} ${String(rule.retainDays).padStart(4)} days  ${
        rule.enabled === false ? 'DISABLED' : 'enabled'
      }`,
    );
  }
  console.log('');
  return 0;
}

process.exit(await main());
