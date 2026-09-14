import { defineConfig } from 'vitest/config';

/**
 * Root runner.
 *
 * Projects rather than one flat `include`, because `packages/web` needs its own resolution: its
 * tests import through the `@/*` alias that Next defines, and a single root config has no way to
 * scope that alias to one package. Running the web suite under the root config resolved `@/middleware`
 * to nothing and failed two tests that pass in isolation — green in one runner and red in another is
 * the worst kind.
 */
export default defineConfig({
  test: {
    /**
     * One test file at a time, across every project.
     *
     * The `api` suites share **one live Postgres, MinIO and Valkey** — deliberately: D2-09's whole
     * argument is that a mocked database proves the handlers call drizzle and nothing else. Run in
     * parallel they are flaky in a way that is worse than a failure, because it moves. Five full
     * runs on 14 Sep failed five *different* tests and never the same one twice:
     * `consumers/evidence.test.ts`'s 4 s poll, `retention.test.ts > AC 8`,
     * `metrics.test.ts > the estate snapshot`, `alerts.test.ts`'s live SSE client, and
     * `coverage.test.ts`'s `expected 35 to be 37`.
     *
     * They share one shape: each reads the same mutating table **twice** and compares the reads.
     * `coverage.test.ts:289-299` computes coverage over the whole estate and then counts `cameras`;
     * `retention.test.ts` AC 8 reads the estate through the API and then again through SQL. Any
     * concurrent insert or delete between the two reads fails them, and no per-test fixture
     * isolation helps, because the rows they disagree about belong to a *different suite*.
     *
     * **It must be set here, at the root.** Vitest 3 ignores `fileParallelism` inside
     * `projects[].test`, and the symptom is silent: the run looks serial because it takes six times
     * longer, while the summary quietly reports more `tests` time than wall-clock `Duration` —
     * which is only possible if files still overlap. That reading is the check: after this change
     * `tests` must be less than `Duration`.
     *
     * The cost is wall-clock. The benefit is a suite whose result can be quoted as evidence, which
     * D4-SUBMIT needs and which an intermittently red suite can never be.
     */
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'api',
          include: ['packages/api/src/**/*.test.ts', 'packages/shared/src/**/*.test.ts'],
          environment: 'node',
          root: import.meta.dirname,
        },
      },
      './packages/web/vitest.config.ts',
    ],
  },
});
