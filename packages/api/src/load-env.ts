/**
 * Loads the repository-root `.env`, whatever the working directory.
 *
 * `import 'dotenv/config'` resolves `.env` from `process.cwd()`, and npm workspaces run every
 * script from `packages/api/`. So `npm run consume:evidence` from the repo root never saw the root
 * `.env` and exited with "MINIO_ACCESS_KEY / MINIO_SECRET_KEY are not set" while both were set
 * (D4-14). Anchoring on this file's own location fixes every entrypoint at once. `src/` and `dist/`
 * sit at the same depth, so the path holds for both.
 *
 * A missing file is a no-op, which Railway relies on: there the platform injects the variables.
 * Values already in the environment win, so `set -a; . ./.env` and platform variables are never
 * overridden.
 */
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
