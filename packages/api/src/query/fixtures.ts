/**
 * Loading D3-09's fixture corpora.
 *
 * Resolved from `import.meta.url` rather than the process cwd, following
 * `services/plate-search.ts`'s `config/plate-confusions.json` path: a suite run through
 * `npm run test -w packages/api` has its cwd inside the workspace, one run from the repo root does
 * not, and a fixture that only loads under one of them is a test that passes in one runner and
 * fails in another — which the root `vitest.config.ts` already warns about in its own comment.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QueryDSL } from '@saakshi/shared';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function fixturePath(name: string): string {
  return path.join(REPO_ROOT, 'fixtures', name);
}

export interface NlQueryFixture {
  id: string;
  question: string;
  /** What this question is testing, so a failure reports something a reader can act on. */
  tests: string;
  expected: QueryDSL;
}

export interface NlQueryFixtures {
  /** Anchors every relative expression, so a compile is reproducible across days. */
  now: string;
  vocabulary: { cameraExternalIds: string[]; districts: string[] };
  fixtures: NlQueryFixture[];
}

export interface InjectionCorpus {
  /** Hostile natural-language inputs, put through the real compiler. */
  prompts: { id: string; text: string; expect: string }[];
  /** What a fully compromised model would emit, fed straight to the SQL builder. */
  payloads: { id: string; why: string; dsl: QueryDSL }[];
  /** Output that must not validate at all. */
  rejected: { id: string; why: string; value: unknown }[];
}

export function loadNlQueryFixtures(): NlQueryFixtures {
  return JSON.parse(readFileSync(fixturePath('nl-queries.json'), 'utf8')) as NlQueryFixtures;
}

export function loadInjectionCorpus(): InjectionCorpus {
  return JSON.parse(readFileSync(fixturePath('nl-query-injections.json'), 'utf8')) as InjectionCorpus;
}
