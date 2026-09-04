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
        },
      },
      './packages/web/vitest.config.ts',
    ],
  },
});
