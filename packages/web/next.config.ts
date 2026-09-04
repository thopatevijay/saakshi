import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace package ships TypeScript sources compiled to dist/; transpiling keeps the web
  // build working before `@saakshi/shared` is built.
  transpilePackages: ['@saakshi/shared'],
  eslint: {
    // Linting is a root-level concern (`npm run lint`), not a per-build one.
    ignoreDuringBuilds: true,
  },
};

export default config;
