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
    projects: [
      {
        test: {
          name: 'api',
          include: ['packages/api/src/**/*.test.ts', 'packages/shared/src/**/*.test.ts'],
          environment: 'node',
          root: import.meta.dirname,
          /**
           * One file at a time, because these suites share **one live Postgres, MinIO and Valkey**
           * — deliberately: D2-09's whole argument is that a mocked database proves the handlers
           * call drizzle and nothing else.
           *
           * Run in parallel they are flaky in a way that is worse than a failure, because it moves.
           * Four consecutive full runs on 14 Sep failed four *different* tests and never the same
           * one twice: `consumers/evidence.test.ts`'s 4 s poll, `retention.test.ts > AC 8`,
           * `metrics.test.ts > the estate snapshot`, and `coverage.test.ts`'s
           * `expected 35 to be 37`.
           *
           * They share one shape. Each reads the same mutating table **twice** and compares the two
           * reads — `coverage.test.ts:294-299` computes coverage over the estate then counts
           * `cameras`; AC 8 reads the estate through the API then again through SQL. A concurrent
           * insert or delete between the two reads fails them, and no per-test fixture isolation
           * helps, because the rows they disagree about belong to a different suite.
           *
           * The cost is wall-clock. The benefit is a suite whose result can be quoted as evidence,
           * which D4-SUBMIT needs and which an intermittently red suite can never be.
           */
          fileParallelism: false,
        },
      },
      './packages/web/vitest.config.ts',
    ],
  },
});
