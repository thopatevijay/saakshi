# SAAKSHI API — Fastify on Node 22.
#
# Build context is the REPO ROOT, not this directory: the API is one workspace of an npm workspaces
# monorepo and shares the root lockfile with `@saakshi/shared`. Build it with
# `docker build -f packages/api/Dockerfile .`; `railway.json` sets the same thing.
#
# Two stages. The builder installs the whole workspace and compiles TypeScript; the runner gets
# production dependencies plus the emitted `dist/`. Nothing that can read a secret is in a layer —
# see `.dockerignore`, which excludes `.env` explicitly.

# ── builder ───────────────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Manifests first, so a dependency-only change is the sole thing that busts the install cache.
# `npm ci` needs every workspace's package.json present or it refuses the lockfile.
COPY package.json package-lock.json ./
COPY packages/shared/package.json  packages/shared/package.json
COPY packages/api/package.json     packages/api/package.json
COPY packages/web/package.json     packages/web/package.json

# The whole workspace, including devDependencies: `tsc` lives there.
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/api    packages/api

# `@saakshi/shared` first — the API imports its compiled `dist/`, not its sources.
RUN npm run build --workspace @saakshi/shared \
 && npm run build --workspace @saakshi/api

# Production dependency tree, resolved separately so the runner never carries `tsc`, `tsx`,
# `drizzle-kit` or `autocannon`.
#
# The workspace filter is not a micro-optimisation. A bare `npm ci --omit=dev` at the root of an npm
# workspaces monorepo installs the *production* dependencies of **every** workspace — so the API
# image would carry Next.js, React and MapLibre, which it never imports. Measured: 1.24 GB without
# the filter. Image size is cold-start time on a platform that pulls before it starts, and cold
# start is one of this ticket's acceptance criteria.
RUN npm ci --omit=dev \
      --workspace @saakshi/api \
      --workspace @saakshi/shared \
      --include-workspace-root

# ── runner ────────────────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# postgresql-client is not decoration: the release command runs migrations and the D4-01 validation
# gate runs `psql` against the deployed database from inside this image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules                   ./node_modules
COPY --from=builder /app/package.json                   ./package.json
COPY --from=builder /app/packages/shared/package.json   ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist           ./packages/shared/dist
COPY --from=builder /app/packages/api/package.json      ./packages/api/package.json
COPY --from=builder /app/packages/api/dist              ./packages/api/dist

# The migration runner resolves `db/migrations` four levels up from its own compiled location
# (`packages/api/dist/db/migrate.js` → `/app/db/migrations`), so the SQL must sit at the repo-root
# position inside the image. `db/init` carries the extension bootstrap the deployed database needs,
# because Railway mounts no `docker-entrypoint-initdb.d`.
COPY db ./db

# Runtime configuration the server reads from the repo root by absolute-ish path, not from env:
# `config/trust-weights.json` is read at *import* time by the trust service, so the process exits
# before it ever listens if this is missing (verified — the first build of this image did exactly
# that). `config/` also carries the alert, anomaly, retention and plate-confusion policies.
COPY config ./config

# 8 MB, and it earns it: `fixtures/watchlist-seed.csv` is the 235-row representative watchlist the
# watchlist service loads, and `fixtures/plate-eval/crops` holds the real plate crops that
# `npm run demo:trace` puts behind the seeded demonstration state D4-02 needs.
COPY fixtures ./fixtures

# npm workspaces hoist every dependency to the root `node_modules` and link each workspace in as a
# relative symlink (`node_modules/@saakshi/shared -> ../../packages/shared`). COPY preserves the
# symlink, and the two lines above put the real directory back under it. Re-pointing it explicitly
# costs nothing and makes the layout survive a future hoisting change.
RUN ln -sfn /app/packages/shared /app/node_modules/@saakshi/shared

EXPOSE 4000
# Railway injects PORT. The server reads API_PORT, so bridge them here rather than teaching the
# app a platform-specific variable name.
CMD ["sh", "-c", "API_PORT=${PORT:-${API_PORT:-4000}} node packages/api/dist/index.js"]
