#!/usr/bin/env node
/**
 * `.env.example` sync check — D4-07 AC 6.
 *
 * `.env.example` is the committed contract: it is the only place a fresh clone can discover which
 * variables this system reads. `packages/api/src/env.ts` says so in its own header — *"Every key
 * here must exist in `.env.example` — the API reads nothing that a fresh clone cannot discover."*
 * Nothing enforced it, so this does.
 *
 * ## Two passes, deliberately of different strictness
 *
 * **Pass A — explicit environment access.** `process.env.X`, `process.env['X']`, `os.environ[...]`,
 * `os.environ.get(...)`, `os.getenv(...)`, the API's zod `EnvSchema`, and `${X}` in
 * `docker-compose.yml`. These unambiguously read the environment, so a key found here and missing
 * from `.env.example` is **fatal**: a judge cannot configure what the contract never mentions.
 *
 * **Pass B — bare uppercase string literals.** Several subsystems read through a local helper —
 * `_float("SAAKSHI_PLATE_CONF_MIN", ...)` in `workers/analytics/anpr/thresholds.py`,
 * `number('REID_SIMILARITY_MIN', ...)` in `packages/api/src/services/reid.ts` — which pass A cannot
 * see. Pass B is used for **one purpose only**: deciding whether a *documented* key is referenced
 * somewhere, so the orphan list does not accuse live keys of being dead. It never adds a required
 * key, because a bare literal is not proof that the environment is read.
 *
 * ## What is out of scope, on purpose
 *
 * `scripts/*.sh` are build and ops tooling (`import-osm.sh`, `build-basemap.sh`). Their `${FORCE:-0}`
 * / `${BBOX:-...}` locals are invocation flags with in-script defaults, documented alongside the
 * commands that take them — not application configuration a clone must discover. Scanning them
 * pulled in 14 shell locals and said nothing true about the contract.
 *
 * Run: `node scripts/check-env-sync.js`  (add `--verbose` to list where each key is read)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERBOSE = process.argv.includes('--verbose');

/**
 * Keys the runtime or the platform injects. A fresh clone neither sets nor needs them, so their
 * absence from `.env.example` is correct rather than a gap.
 */
const PROVIDED_BY_PLATFORM = new Map([
  ['NODE_ENV', 'set by the npm scripts and by the deploy'],
  ['TZ', 'process timezone; pinned by compose and by the deploy, not by a judge'],
  ['PORT', 'injected by the hosting platform'],
  ['CI', 'set by the CI runner'],
  ['RAILWAY_PUBLIC_DOMAIN', 'injected by Railway'],
  ['CHROME_PATH', "a local browser path; docs:render probes for it and it is the developer's own"],
  ['COMPOSE_PROJECT_NAME', 'set by Docker Compose itself'],
]);

const SCAN_DIRS = ['packages', 'scripts', 'workers'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.venv',
  'coverage',
  '__pycache__',
  '.turbo',
]);
/** Application code only — see the header on why `.sh` is absent. */
const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.py']);
/** This file quotes key names in its own comments and regexes; it is not a read site. */
const SELF = basename(fileURLToPath(import.meta.url));

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if (CODE_EXT.has(extname(e.name)) && e.name !== SELF) {
      out.push(full);
    }
  }
  return out;
}

function record(map, key, file) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(relative(ROOT, file));
}

/** Pass A: explicit environment access. Drives the fatal check. */
const envReads = new Map();
/** Pass B: any uppercase string literal. Only clears the orphan list. */
const literals = new Map();

// --- The API's zod contract. Read through `env.X`, so a `process.env` sweep misses all thirty. ---
const envTsPath = join(ROOT, 'packages/api/src/env.ts');
const envTs = readFileSync(envTsPath, 'utf8');
const schemaStart = envTs.indexOf('z.object({');
if (schemaStart === -1) {
  console.error(`FAIL: no \`z.object({\` in ${relative(ROOT, envTsPath)} — this parser needs updating.`);
  process.exit(2);
}
let depth = 0;
let schemaEnd = -1;
for (let i = schemaStart + 'z.object('.length; i < envTs.length; i += 1) {
  const c = envTs[i];
  if (c === '{') depth += 1;
  else if (c === '}') {
    depth -= 1;
    if (depth === 0) {
      schemaEnd = i;
      break;
    }
  }
}
if (schemaEnd === -1) {
  console.error(`FAIL: unbalanced braces in the EnvSchema of ${relative(ROOT, envTsPath)}.`);
  process.exit(2);
}
for (const m of envTs.slice(schemaStart, schemaEnd).matchAll(/^ {2}([A-Z_][A-Z0-9_]*)\s*:/gm)) {
  record(envReads, m[1], envTsPath);
}

const EXPLICIT = [
  /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/g,
  /os\.(?:environ\s*\[\s*|environ\.get\s*\(\s*|getenv\s*\(\s*)['"]([A-Z_][A-Z0-9_]*)['"]/g,
];
const LITERAL = /['"]([A-Z][A-Z0-9_]{2,})['"]/g;

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const src = readFileSync(file, 'utf8');
    for (const re of EXPLICIT) {
      for (const m of src.matchAll(re)) record(envReads, m[1] ?? m[2], file);
    }
    for (const m of src.matchAll(LITERAL)) record(literals, m[1], file);
  }
}

// --- Compose substitutions: a judge's `docker compose up` reads these. ---
try {
  const composeSrc = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  for (const m of composeSrc.matchAll(/\$\{([A-Z_][A-Z0-9_]*)[:\-+}]/g)) {
    record(envReads, m[1], join(ROOT, 'docker-compose.yml'));
  }
} catch {
  /* compose file is optional for this check */
}

// --- The contract itself. ---
const exampleSrc = readFileSync(join(ROOT, '.env.example'), 'utf8');
const documented = new Set(
  [...exampleSrc.matchAll(/^\s*#?\s*([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]),
);

// --- Diff. ---
const undocumented = [...envReads.keys()]
  .filter((k) => !documented.has(k) && !PROVIDED_BY_PLATFORM.has(k))
  .sort();
const orphaned = [...documented].filter((k) => !envReads.has(k) && !literals.has(k)).sort();

console.log('.env.example sync check');
console.log(`  documented in .env.example : ${documented.size}`);
console.log(`  read explicitly by the code: ${envReads.size}`);
console.log(
  `  platform-provided (ignored): ${[...PROVIDED_BY_PLATFORM.keys()].filter((k) => envReads.has(k)).length}`,
);

if (VERBOSE) {
  console.log('\n  explicit read sites:');
  for (const key of [...envReads.keys()].sort()) {
    console.log(`    ${key.padEnd(30)} ${[...envReads.get(key)].join(', ')}`);
  }
}

if (orphaned.length > 0) {
  console.log(`\n  ORPHANED — documented, referenced nowhere (${orphaned.length}, not fatal):`);
  for (const k of orphaned) console.log(`    ${k}`);
}

if (undocumented.length > 0) {
  console.error(`\n  UNDOCUMENTED — read by the code, missing from .env.example (${undocumented.length}):`);
  for (const k of undocumented) {
    console.error(`    ${k.padEnd(30)} read in ${[...envReads.get(k)].join(', ')}`);
  }
  console.error(
    `\nFAIL: a fresh clone cannot discover ${undocumented.length} variable(s) this code reads.`,
  );
  process.exit(1);
}

console.log('\nOK: every variable the code reads is documented in .env.example.');
