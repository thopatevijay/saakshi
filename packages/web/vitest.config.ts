import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // `tsconfig.json` sets `jsx: "preserve"` because Next does its own JSX transform. Vitest has no
  // Next pipeline, so without this esbuild falls back to the classic runtime and every component
  // test dies on `React is not defined`. The automatic runtime is what Next emits anyway, so this
  // makes the test transform match the build rather than diverge from it.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname),
    },
  },
});
