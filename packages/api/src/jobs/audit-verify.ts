/**
 * `npm run audit:verify [-- --json] [-- --seal]`
 *
 * Walks the audit chain and says whether it holds. Exit 0 on a chain that verifies, 1 on one that
 * does not — so it can sit in a gate, a cron, or a judge's terminal without anyone having to read
 * prose to find out the answer.
 *
 * `--seal` records, in the chain itself, where the pre-canonical prologue ends. It is needed exactly
 * once, on a database that carries entries written before D3-04's canonical digest existed; a
 * database migrated from empty never needs it and the flag refuses to do anything. See
 * `docs/chain-of-custody.md`.
 */
import 'dotenv/config';
import { createDb, createSql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { sealChainEpoch, verifyChain, type ChainVerification } from '../services/audit.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const seal = args.includes('--seal');

const env = loadEnv();
const rawSql = createSql(env.DATABASE_URL, 2);
const db = createDb(rawSql);

function report(result: ChainVerification): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('SAAKSHI audit chain');
  console.log(`  algorithm        ${result.algorithm}`);
  console.log(`  entries          ${result.entries}`);
  console.log(`  verified         ${result.verifiedEntries}`);
  if (result.preCanonicalEntries > 0) {
    console.log(
      `  pre-canonical    ${result.preCanonicalEntries}  (written before D3-04; linkage verified, payload not re-hashable)`,
    );
    console.log(`  epoch sealed     ${result.epochSealed ? 'yes' : 'NO'}`);
  }
  console.log(`  tip              ${result.tipHash ?? '(empty chain)'}`);
  if (result.forks.length > 0) {
    console.log(`  FORKS            ${result.forks.length}`);
    for (const fork of result.forks) {
      console.log(`    ${fork.prevHash} → ${fork.entryIds.join(', ')}`);
    }
  }

  if (result.ok) {
    console.log('\nPASS — the chain verifies.');
    console.log(
      'This proves tamper EVIDENCE, not tamper prevention: an alteration to any single entry is\n' +
        'detectable, and every entry after it. See docs/chain-of-custody.md.',
    );
    return;
  }

  const b = result.firstBreak;
  console.log('\nFAIL — the chain does not verify.');
  if (b === null) {
    console.log('  no single entry is at fault; see the forks listed above');
    return;
  }
  console.log(`  reason           ${b.reason}`);
  console.log(`  first break at   entry ${b.position} of ${result.entries}`);
  console.log(`  entry id         ${b.entry.id}`);
  console.log(`  seq              ${b.entry.seq}`);
  console.log(`  written          ${b.entry.ts}`);
  console.log(`  action           ${b.entry.action}`);
  console.log(`  actor            ${b.entry.actorBadgeNo ?? 'system'} (${b.entry.actorRole ?? 'system'})`);
  console.log(`  expected         ${b.expected}`);
  console.log(`  actual           ${b.actual}`);
  console.log(`\n  ${b.detail}`);
}

try {
  if (seal) {
    const outcome = await sealChainEpoch(db);
    if (asJson) console.log(JSON.stringify(outcome));
    else if (outcome.sealed) {
      console.log(`sealed ${outcome.preCanonicalEntries} pre-canonical entr${outcome.preCanonicalEntries === 1 ? 'y' : 'ies'}\n`);
    } else {
      console.log(`nothing sealed — ${outcome.reason ?? 'no reason given'}\n`);
    }
  }

  const result = await verifyChain(db);
  report(result);
  process.exitCode = result.ok ? 0 : 1;
} finally {
  await rawSql.end();
}
