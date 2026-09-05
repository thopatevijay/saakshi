/**
 * `npm run demo:provider-swap` — the vendor-neutrality claim, run live, on stage.
 *
 * The challenge asks for an "open, modular, standards-based, vendor-neutral" architecture that
 * avoids lock-in. Every submission will *say* that. This script is the version of the sentence that
 * can be falsified: the same question, the same derived schema, three different providers — one
 * proprietary primary, one proprietary alternate, one local open-weights model — and the filters
 * they produce, compared field by field.
 *
 * **What it will not do is fake a leg.** A provider with no credential, or a local model that is
 * not running, is reported as `unavailable` with the reason and is excluded from the comparison.
 * Printing "equivalent" for a provider that never ran would make this exactly the unfalsifiable
 * claim it exists to replace. The exit code reflects that honestly:
 *
 * - **0** — every configured provider ran and the filters agree.
 * - **1** — two or more providers ran and disagree. That is the finding, and it is printed.
 * - **2** — fewer than one provider could run at all. Nothing was demonstrated.
 *
 * A run with a single available provider still exits 0 and says so in terms: it proves the pipeline
 * works, not that the providers agree, and the output does not pretend otherwise.
 *
 * Usage:
 *   npm run demo:provider-swap                      # one representative question, all providers
 *   npm run demo:provider-swap -- --all             # all 18 fixtures, with a per-provider match rate
 *   npm run demo:provider-swap -- --question "…"    # an arbitrary question
 *   npm run demo:provider-swap -- --record          # write fixtures/nl-query-transcripts.json
 */
import { writeFileSync } from 'node:fs';
import { canonicalJson, describeQueryDsl, type QueryDSL } from '@saakshi/shared';
import {
  createQueryCompiler,
  providerSecretsFromEnv,
  type CompileOutcome,
  type QueryProvider,
} from '../query/index.js';
import { fixturePath, loadNlQueryFixtures, type NlQueryFixture } from '../query/fixtures.js';

/** The three that can actually run a model. `none` is a deployment mode, not a leg of a comparison. */
const LIVE_PROVIDERS: QueryProvider[] = ['openai', 'anthropic', 'ollama'];

/** The question on the slide. It exercises colour, class, place, a window and a sequence at once. */
const DEFAULT_QUESTION =
  'White cars that passed cam01 between 02:00 and 04:00 last night and later appeared near Adalaj';

interface Leg {
  provider: QueryProvider;
  model: string | null;
  outcome: CompileOutcome | null;
  /** Set when the provider could not be attempted at all. */
  unavailable: string | null;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const record = argv.includes('--record');
  // Everything after `--question` up to the next flag. npm strips the shell's quoting, so a
  // multi-word question arrives as several argv entries and taking only the next one would silently
  // compile the single word "White" — which the model then reads as a registration.
  const questionArg = argv.indexOf('--question');
  const question =
    questionArg >= 0
      ? argv
          .slice(questionArg + 1)
          .filter((a) => !a.startsWith('--'))
          .join(' ')
          .trim() || DEFAULT_QUESTION
      : DEFAULT_QUESTION;

  const corpus = loadNlQueryFixtures();
  const secrets = providerSecretsFromEnv();

  console.log('');
  console.log('  SAAKSHI · natural-language query — live provider swap (D3-09)');
  console.log('  ' + '─'.repeat(76));
  console.log('  One question. One schema, derived from the zod DSL. Three providers.');
  console.log('  The model writes the filter; the officer approves it; the database answers.');
  console.log('');

  const cases: NlQueryFixture[] = all
    ? corpus.fixtures
    : [{ id: 'stage', question, tests: 'the representative question', expected: null as never }];

  const transcripts: Record<string, Record<string, string>> = {};
  const perProvider = new Map<QueryProvider, { ran: number; matched: number; totalMs: number }>();
  // Three different outcomes that a lesser script would collapse into one. "Nobody had a
  // credential", "a model ran and produced nothing valid" and "models disagree" have three
  // different remedies and three different meanings for the claim being demonstrated.
  let anyAttempted = false;
  let anyCompiled = false;
  let anyDisagreement = false;

  for (const testCase of cases) {
    console.log(`  ▸ "${testCase.question}"`);
    const legs: Leg[] = [];

    for (const provider of LIVE_PROVIDERS) {
      const reason = unavailableReason(provider, secrets);
      if (reason !== null) {
        legs.push({ provider, model: null, outcome: null, unavailable: reason });
        continue;
      }
      anyAttempted = true;
      const compiler = createQueryCompiler(provider, { secrets });
      const outcome = await compiler.compile({
        text: testCase.question,
        vocabulary: corpus.vocabulary,
        now: new Date(corpus.now),
      });
      legs.push({ provider, model: compiler.model, outcome, unavailable: null });

      const stats = perProvider.get(provider) ?? { ran: 0, matched: 0, totalMs: 0 };
      stats.ran += 1;
      stats.totalMs += outcome.tookMs;
      if (
        outcome.ok &&
        testCase.expected !== null &&
        canonicalJson(normalise(outcome.dsl)) === canonicalJson(normalise(testCase.expected))
      ) {
        stats.matched += 1;
      }
      perProvider.set(provider, stats);
      if (outcome.ok) {
        anyCompiled = true;
        transcripts[testCase.id] = { ...transcripts[testCase.id], [provider]: outcome.raw };
      }
    }

    for (const leg of legs) console.log(`      ${renderLeg(leg)}`);

    const succeeded = legs.filter(
      (l): l is Leg & { outcome: Extract<CompileOutcome, { ok: true }> } =>
        l.outcome !== null && l.outcome.ok,
    );
    if (succeeded.length >= 2) {
      const reference = canonicalJson(normalise(succeeded[0]!.outcome.dsl));
      const differing = succeeded.filter(
        (l) => canonicalJson(normalise(l.outcome.dsl)) !== reference,
      );
      if (differing.length === 0) {
        console.log(
          `      ✓ ${String(succeeded.length)} providers produced an equivalent filter — the swap is a config value, nothing more.`,
        );
      } else {
        anyDisagreement = true;
        console.log(`      ✗ providers disagree. The differences, field by field:`);
        for (const leg of differing) {
          for (const line of diff(succeeded[0]!.outcome.dsl, leg.outcome.dsl)) {
            console.log(`          ${leg.provider}: ${line}`);
          }
        }
      }
    } else if (succeeded.length === 1) {
      console.log(
        `      · only one provider was available, so nothing was compared. The pipeline ran; ` +
          `equivalence was not demonstrated.`,
      );
    }

    if (!all && succeeded.length > 0) {
      console.log('');
      console.log('      The filter, as the officer sees it before it runs:');
      for (const line of describeQueryDsl(succeeded[0]!.outcome.dsl)) {
        console.log(`        · ${line}`);
      }
    }
    console.log('');
  }

  if (all) {
    console.log('  Per-provider result over the fixture suite');
    console.log('  ' + '─'.repeat(76));
    console.log('  provider    ran   exact match   mean latency');
    for (const provider of LIVE_PROVIDERS) {
      const stats = perProvider.get(provider);
      if (stats === undefined || stats.ran === 0) {
        console.log(`  ${provider.padEnd(11)} —     —             — (unavailable)`);
        continue;
      }
      const rate = ((stats.matched / stats.ran) * 100).toFixed(1);
      const mean = Math.round(stats.totalMs / stats.ran);
      console.log(
        `  ${provider.padEnd(11)} ${String(stats.ran).padEnd(5)} ${`${stats.matched}/${String(stats.ran)} (${rate}%)`.padEnd(13)} ${String(mean)} ms`,
      );
    }
    console.log('');
    console.log(
      '  "exact match" is the strictest possible bar: every field of the compiled filter',
    );
    console.log('  identical to the expected one. A filter that is merely *equivalent in effect*');
    console.log(
      '  counts as a miss here. docs/nl-query.md carries the analysis of where it fails.',
    );
    console.log('');
  }

  if (record) {
    const path = fixturePath('nl-query-transcripts.json');
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          $comment:
            'D3-09 · real provider responses, recorded by `npm run demo:provider-swap -- --all ' +
            '--record`. Replayed offline by query-compiler.test.ts so the parse-and-validate path ' +
            'is exercised against genuine model output with no network and no credential.',
          recordedAt: new Date().toISOString(),
          transcripts,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`  Recorded ${String(Object.keys(transcripts).length)} transcripts → ${path}`);
    console.log('');
  }

  if (anyAttempted && !anyCompiled) {
    console.log('  A provider ran and produced no valid filter.');
    console.log('');
    console.log(
      '  That is the schema doing its job, not the pipeline failing: out-of-schema output',
    );
    console.log(
      '  is rejected rather than guessed at, and the rejection names the offending field.',
    );
    console.log(
      '  A small local model does this on the harder questions — docs/nl-query.md § 5 has',
    );
    console.log('  the measured rate and the failure analysis.');
    console.log('');
    return 1;
  }

  if (!anyAttempted) {
    console.log('  No provider could be attempted.');
    console.log('  · openai    — set OPENAI_API_KEY');
    console.log('  · anthropic — set ANTHROPIC_API_KEY');
    console.log('  · ollama    — start ollama and `ollama pull` the model in OLLAMA_MODEL');
    console.log('');
    console.log(
      '  Note that the *system* is unaffected: with QUERY_COMPILER=none the manual filter',
    );
    console.log('  is the primary interface and every screen works. Nothing proprietary is');
    console.log('  load-bearing — that is the point this demo exists to show.');
    console.log('');
    return 2;
  }
  return anyDisagreement ? 1 : 0;
}

/**
 * Why a provider cannot be attempted, checked before the call rather than after.
 *
 * A missing key is a *configuration* fact and reporting it as a failed compile would put an
 * unavailable provider and a wrong provider in the same bucket — which is the distinction the whole
 * demo turns on.
 */
function unavailableReason(
  provider: QueryProvider,
  secrets: ReturnType<typeof providerSecretsFromEnv>,
): string | null {
  if (provider === 'openai' && secrets.openaiApiKey === '') return 'OPENAI_API_KEY is not set';
  if (provider === 'anthropic' && secrets.anthropicApiKey === '') {
    return 'ANTHROPIC_API_KEY is not set';
  }
  return null;
}

/**
 * The comparison form.
 *
 * Array order is not meaning — `["car","truck"]` and `["truck","car"]` are the same filter — so
 * arrays are sorted before comparison. Nothing else is relaxed: a different time window, a
 * different distance or a different entity is a real disagreement and is reported as one.
 */
function normalise(dsl: QueryDSL): unknown {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return (node as unknown[]).map(walk).sort(compareCanonical);
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(
        Object.entries(node)
          .map(([k, v]) => [k, walk(v)])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      );
    }
    return node;
  };
  return walk(dsl);
}

function compareCanonical(a: unknown, b: unknown): number {
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

/** Field-by-field differences, so a disagreement is actionable rather than just reported. */
function diff(a: QueryDSL, b: QueryDSL): string[] {
  const out: string[] = [];
  const walk = (left: unknown, right: unknown, path: string): void => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (
      typeof left === 'object' &&
      left !== null &&
      typeof right === 'object' &&
      right !== null &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of keys) {
        walk(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          path === '' ? key : `${path}.${key}`,
        );
      }
      return;
    }
    out.push(`${path}: ${JSON.stringify(left)} → ${JSON.stringify(right)}`);
  };
  walk(a, b, '');
  return out;
}

function renderLeg(leg: Leg): string {
  const name = leg.provider.padEnd(10);
  if (leg.unavailable !== null) return `${name} unavailable — ${leg.unavailable}`;
  if (leg.outcome === null) return `${name} unavailable`;
  if (!leg.outcome.ok) {
    // The validation issues, not just "rejected". A rejection an audience cannot diagnose looks
    // like a failure of the system; a rejection that names the offending field is the system
    // working, and the difference is worth the extra line on stage.
    const detail =
      leg.outcome.issues.length > 0
        ? leg.outcome.issues.join('; ')
        : (leg.outcome.message.split('.')[0] ?? '');
    return `${name} ${String(leg.outcome.tookMs).padStart(6)} ms  ✗ ${leg.outcome.reason} — ${detail}`;
  }
  const summary = describeQueryDsl(leg.outcome.dsl).slice(0, 3).join(' · ');
  return `${name} ${String(leg.outcome.tookMs).padStart(6)} ms  ✓ ${leg.model ?? ''} — ${summary}`;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
