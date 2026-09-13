import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      // `next build`'s output, kept separate from `.next` so a build cannot delete the chunks a
      // running `next dev` is serving — see packages/web/src/lib/dist-dir.ts (D3-13).
      '**/.next-prod/**',
      '**/build/**',
      '**/*.d.ts',
      '.venv/**',
      'recon-out/**',
      'data/**',
      // Railway's Infrastructure-as-Code authoring file (D4-01). It imports `railway/iac` and is
      // evaluated by Railway's own runtime, not by anything this repo builds, so it sits outside
      // every tsconfig — type-aware linting can only report it as an unmatched file.
      '.railway/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Root-level tooling config is in no package's tsconfig; type-aware linting still applies.
        projectService: {
          allowDefaultProject: ['vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The stack forbids escape hatches — see CLAUDE.md and PROJECT.md §13.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // Config files and standalone tooling scripts are not part of any tsconfig's `include`, so
    // type-aware rules cannot run on them. They are still Node programs, so they get Node globals —
    // without this, every `console.log` in a build script reads as an undefined variable.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  prettier,
);
