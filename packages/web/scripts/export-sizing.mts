/**
 * Scenario -> Markdown on stdout (D3-08).
 *
 *   npm run export:sizing -- --scenario statewide > docs/sizing-model.md
 *
 * Lives beside the screen rather than in the API because it has no database, no network and no
 * environment: it renders the same pure model the `/sizing` page runs, so the document and the
 * product cannot drift. `docs/sizing-model.md` is a direct input to two mandatory HLD dimensions
 * (D4-04, D4-05) and must never be hand-written.
 *
 * Overrides are accepted as `--set <constantKey>=<number>`, repeatable, so the deck can be generated
 * against a department's own tariffs without editing the model.
 */
import { fstatSync, ftruncateSync, writeSync } from 'node:fs';
import {
  CONSTANT_KEYS,
  type ConstantKey,
  SIZING_PRESETS,
  type SizingOverrides,
  presetById,
  renderScenarioMarkdown,
} from '@saakshi/shared';

/**
 * Write the document, and make sure it is the *only* thing in the file.
 *
 * `npm run <script>` prints its `> pkg@version script` banner to **stdout**, not stderr, so the
 * ticket's own validation-gate command —
 *
 *     npm run export:sizing -- --scenario statewide > docs/sizing-model.md
 *
 * — lands four lines of npm preamble at the top of a file that is meant to be pasted straight into
 * the HLD. The script cannot stop npm writing them, but it does own the file descriptor npm wrote
 * them through: when stdout is a regular file we truncate it and write the document at offset zero,
 * which leaves exactly the document. Piped or interactive output is written normally.
 *
 * Doing this here rather than telling every caller to remember `--silent` keeps the gate command in
 * the ticket working as written and the deliverable clean.
 */
function emit(document: string): void {
  const buffer = Buffer.from(document, 'utf8');
  try {
    if (fstatSync(1).isFile()) {
      ftruncateSync(1, 0);
      writeSync(1, buffer, 0, buffer.length, 0);
      return;
    }
  } catch {
    // Not a regular file, or the platform refused the positional write. Fall through.
  }
  process.stdout.write(buffer);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): {
  scenario: string;
  overrides: SizingOverrides;
  includeSection9: boolean;
  includeProvenance: boolean;
} {
  let scenario = 'statewide';
  const overrides: SizingOverrides = {};
  let includeSection9 = true;
  let includeProvenance = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scenario' || arg === '-s') {
      const next = argv[i + 1];
      if (next === undefined) fail('--scenario needs a value');
      scenario = next;
      i += 1;
    } else if (arg === '--set') {
      const next = argv[i + 1];
      if (next === undefined) fail('--set needs <constantKey>=<number>');
      const [rawKey, rawValue] = next.split('=');
      if (rawKey === undefined || rawValue === undefined) {
        fail(`--set expects <constantKey>=<number>, got "${next}"`);
      }
      if (!(CONSTANT_KEYS as readonly string[]).includes(rawKey)) {
        fail(`unknown constant "${rawKey}". Known keys:\n  ${CONSTANT_KEYS.join('\n  ')}`);
      }
      const value = Number(rawValue);
      if (!Number.isFinite(value)) fail(`--set ${rawKey} needs a finite number, got "${rawValue}"`);
      overrides[rawKey as ConstantKey] = value;
      i += 1;
    } else if (arg === '--no-section-9') {
      includeSection9 = false;
    } else if (arg === '--no-provenance') {
      includeProvenance = false;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'Usage: npm run export:sizing -- --scenario <id> [--set key=value]... > docs/sizing-model.md',
          '',
          `Scenarios: ${SIZING_PRESETS.map((p) => p.id).join(', ')}`,
          '',
          'Options:',
          '  --set <constantKey>=<number>   override one constant, repeatable',
          '  --no-section-9                 omit the PROJECT.md section 9 reconciliation',
          '  --no-provenance                omit the full provenance table',
          '',
        ].join('\n'),
      );
      process.exit(0);
    } else if (arg !== undefined && arg.startsWith('-')) {
      fail(`unknown option "${arg}" — try --help`);
    }
  }

  return { scenario, overrides, includeSection9, includeProvenance };
}

const { scenario, overrides, includeSection9, includeProvenance } = parseArgs(
  process.argv.slice(2),
);

const preset = presetById(scenario);
if (preset === undefined) {
  fail(
    `unknown scenario "${scenario}". Known scenarios: ${SIZING_PRESETS.map((p) => p.id).join(', ')}`,
  );
}

emit(renderScenarioMarkdown({ preset, overrides, includeSection9, includeProvenance }));
