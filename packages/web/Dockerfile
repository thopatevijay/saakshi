# SAAKSHI web console — Next.js 15 on Node 22.
#
# Build context is the REPO ROOT (npm workspaces, shared lockfile):
# `docker build -f packages/web/Dockerfile .` — `railway.json` sets the same.
#
# Three stages, because the basemap is expensive and independent:
#
#   basemap   fetches and extracts data/gujarat.pmtiles + the label glyphs (network, ~1-3 min)
#   builder   installs the workspace and runs `next build`
#   runner    production deps + `.next-prod` + the basemap
#
# Splitting the basemap out means an ordinary code change never re-downloads 28 MB of tiles.

# ── basemap ───────────────────────────────────────────────────────────────────────────────────────
# The console makes **zero external requests at runtime** — no tile API key, nothing that phones
# home mid-investigation. That property is bought here, at build time, once. `data/` is gitignored
# build output, so the image must produce it rather than copy it: a Railway build starts from a git
# clone and would otherwise ship a web server with no map at all.
FROM node:22-bookworm-slim AS basemap
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/build-basemap.sh scripts/build-basemap.sh
# Deliberately UNPINNED by default, which is the opposite of the usual rule, so here is the reason.
#
# Protomaps keeps its daily planet builds for about **six days** — measured 2026-09-13:
# `20260908.pmtiles` answers 206, `20260906.pmtiles` answers 404. A date baked into this file is
# therefore guaranteed to 404 within a week, and it fails at *image build* time, which means the
# deploy stops working for a reason that has nothing to do with the deploy. An empty value makes
# `build-basemap.sh` resolve the newest build that actually exists.
#
# Reproducibility is not lost, it is just bounded by upstream: pass `--build-arg PROTOMAPS_BUILD=…`
# to pin one inside the retention window, and `data/basemap-build.txt` in the image records exactly
# which extract shipped, including its OSM replication timestamp.
ARG PROTOMAPS_BUILD=
RUN bash scripts/build-basemap.sh "$PROTOMAPS_BUILD" 12 \
 && data/.tools/pmtiles show data/gujarat.pmtiles > data/basemap-build.txt \
 && cat data/basemap-build.txt

# ── builder ───────────────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app
# `next build` is a production build by definition, and `distDirFor` reads NODE_ENV. Stated
# explicitly so the output directory is never in doubt — see packages/web/src/lib/dist-dir.ts.
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
COPY packages/shared/package.json  packages/shared/package.json
COPY packages/api/package.json     packages/api/package.json
COPY packages/web/package.json     packages/web/package.json
# `--include=dev` because NODE_ENV=production makes npm skip devDependencies by default, and the
# build needs `next`'s toolchain, Tailwind and `typescript`.
RUN npm ci --include=dev

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/web    packages/web
# The API's *sources*, and this is not a mistake. `packages/web/scripts/generate-api-types.mts`
# imports `../../api/src/server.js` to boot the real server and emit its OpenAPI document — that is
# what keeps `lib/api/schema.d.ts` generated rather than hand-written. `next build` typechecks the
# whole package including `scripts/`, so the import has to resolve or the build fails with
# `Cannot find module '../../api/src/server.js'`. TypeScript only; nothing from here is emitted.
COPY packages/api    packages/api

# The web app imports `@saakshi/shared`'s compiled output, so it is built first.
RUN npm run build --workspace @saakshi/shared \
 && npm run build --workspace @saakshi/web

# Production tree only, filtered to this workspace — a bare `npm ci --omit=dev` at the root of a
# workspaces monorepo also installs the API's dependencies (Fastify, postgres, ioredis), which this
# image never imports.
RUN npm ci --omit=dev \
      --workspace @saakshi/web \
      --workspace @saakshi/shared \
      --include-workspace-root

# `next start` loads `next.config.ts`, and loading a TypeScript config requires the `typescript`
# package at RUNTIME — not just at build time. The production install above prunes it, and Next's
# response to that is to install it itself, on boot, with yarn:
#
#     ⚠ Installing TypeScript as it was not found while loading "next.config.ts".
#     Installing devDependencies (yarn): - typescript@5.8.2
#     yarn add v1.22.22 / info No lockfile found.
#
# A production container that reaches the network on boot to install a compiler is wrong three
# times over: it is slow (cold start is one of this ticket's acceptance criteria), it fails closed
# on an air-gapped or egress-restricted network — which is precisely the deployment this project
# argues for — and it introduces yarn into an npm repository with no lockfile to pin it.
#
# `--no-save` keeps package.json untouched; this is an image detail, not a dependency change.
RUN npm install --no-save --omit=optional typescript

# ── runner ────────────────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/node_modules                 ./node_modules
COPY --from=builder /app/package.json                 ./package.json
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist         ./packages/shared/dist

COPY --from=builder /app/packages/web/package.json    ./packages/web/package.json
COPY --from=builder /app/packages/web/next.config.ts  ./packages/web/next.config.ts
COPY --from=builder /app/packages/web/tsconfig.json   ./packages/web/tsconfig.json
# (no `packages/web/public` — every static asset this console serves is either bundled by Next or
# streamed from `data/` by the /basemap route handler, so there is no public directory to copy.)
# `src/lib/dist-dir.ts` is imported by next.config.ts, which `next start` loads at boot — so the
# source file has to be here, not only its compiled form.
COPY --from=builder /app/packages/web/src/lib/dist-dir.ts ./packages/web/src/lib/dist-dir.ts

# **`.next-prod`, never `.next`.** D3-13 split the two so a production build cannot delete a running
# dev server's chunks; the consequence for any image is that `.next` does not exist in a build-only
# container and copying it would ship an empty directory — which presents as a blank GIS map with no
# error anywhere. See packages/web/src/lib/dist-dir.ts.
COPY --from=builder /app/packages/web/.next-prod      ./packages/web/.next-prod

# The self-hosted basemap: a 28 MB PMTiles extract plus 400 kB of SDF label glyphs, served by
# `app/basemap/[...asset]/route.ts` with Range support. PMTILES_PATH points the handler straight at
# the file rather than letting it walk up from the working directory.
COPY --from=basemap /app/data/gujarat.pmtiles  ./data/gujarat.pmtiles
COPY --from=basemap /app/data/basemap-fonts    ./data/basemap-fonts
# Which extract shipped, and when OSM was last replicated into it. A deployed map that is asked
# "how current is this?" should be able to answer from the image rather than from memory.
COPY --from=basemap /app/data/basemap-build.txt ./data/basemap-build.txt
ENV PMTILES_PATH=/app/data/gujarat.pmtiles

RUN ln -sfn /app/packages/shared /app/node_modules/@saakshi/shared

WORKDIR /app/packages/web
EXPOSE 3000
# Railway injects PORT. `next start` resolves its output directory through the same `distDirFor`
# that the build used, so the two cannot disagree.
# The absolute path is load-bearing: npm workspaces hoist every binary to `/app/node_modules/.bin`,
# and the working directory here is `/app/packages/web`, so a relative `node_modules/.bin/next`
# does not exist and the container exits immediately with `not found`.
CMD ["sh", "-c", "/app/node_modules/.bin/next start --port ${PORT:-3000} --hostname 0.0.0.0"]
