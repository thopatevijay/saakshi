import type { NextConfig } from 'next';
import { distDirFor } from './src/lib/dist-dir';

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace package ships TypeScript sources compiled to dist/; transpiling keeps the web
  // build working before `@saakshi/shared` is built.
  transpilePackages: ['@saakshi/shared'],
  // `next dev` and `next build` get separate output directories, because sharing one lets a
  // production build delete a running dev server's chunks — which presents as a lazily-loaded
  // component stuck on its placeholder forever, with no error anywhere. See `src/lib/dist-dir.ts`
  // for the full failure mode; D3-13 lost a day to it. Anything that copies build output must copy
  // `.next-prod`.
  distDir: distDirFor(process.env),
  eslint: {
    // Linting is a root-level concern (`npm run lint`), not a per-build one.
    ignoreDuringBuilds: true,
  },
};

export default config;
