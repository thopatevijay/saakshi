---
title: "D4-11 · A cold clone does not run green — compose fails to pull, tests are red, the secret scan cries wolf"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "bug", "infra", "test-case", "submission"]
blocked_by: []
estimate: "1.5h"
---

## Context

Three independent defects with one shared consequence: **a judge who clones the repo and follows the
README gets errors.** The repository link is a submission item and `npm start` / `npm test` are the
first two things anyone runs. All three are confirmed on `main` on 14 Sep.

**1 · `docker compose up` cannot pull MinIO** (BL-01 finding 1).
`docker-compose.yml:36` names `minio/minio` and `:50` names `minio/mc`. `docker.io/minio/minio:latest`
now refuses an anonymous pull — `insufficient_scope: authorization failed`. A laptop with a cached
image never notices. A judge hits it immediately, and Docker Compose is `PROJECT.md`'s locked deploy
decision and the judge-facing run path. MinIO publishes the same images anonymously on **quay.io**,
which `ops/minio/Dockerfile` already uses.

**2 · `npm run test` is red on `main` — three failures** (BL-01 findings 2 and 12).
- `packages/api/src/routes/cameras.test.ts › onboard-from-catalogue` — **two** failures. The suite
  guards on Postgres reachability but has **no equivalent guard for the government sandbox**, so an
  expired portal cookie or an unreachable gateway is a *failure* rather than a *skip*.
- `packages/api/src/services/coverage.test.ts › writes one camera_coverage row per live camera` —
  **order-dependent**: `expected 35 to be 37` in the full suite, passes when run alone. Test
  pollution, not a regression.

A red suite is worse than no suite: it is the "a check that always fails is a check nobody reads"
hazard this project has already been bitten by twice (BL-01, D2-09).

**3 · The submission gate's own secret scan reports a leak on a clean repo** (BL-01 finding 3).
`git grep -nE "(sk-ant|AKIA|BEGIN (RSA|OPENSSH) PRIVATE)" -- .` matches the pattern written as
literal text in `.github/plan/D4-01-railway-deploy.md:65` and `.github/plan/D4-07-judge-readme.md:58`.
Reproduced 14 Sep. D4-07's variant (`git log -p --all | grep …`) has the same defect. **D4-SUBMIT
will fail its own gate.**

## Scope

- Repoint both MinIO images in `docker-compose.yml` to `quay.io/minio/…`; confirm a pull works with
  no cached layer
- Give `cameras.test.ts` a sandbox-reachability guard matching the existing Postgres guard, so an
  unreachable or unauthenticated gateway **skips** with a stated reason instead of failing
- Fix `coverage.test.ts`'s order dependence — isolate its fixture rather than widening the assertion
- Add a `":!.github/plan/*"` pathspec to the secret-scan line in **both** D4-01 and D4-07, and to
  D4-SUBMIT's checklist if it carries a copy

## Acceptance Criteria

- [ ] `docker compose config` resolves and both MinIO images pull anonymously — evidenced by a pull
      against a pruned local image cache
- [ ] `npm run test` is **green on a clean `main`**, full suite, run twice in a row — paste the
      summary line from both runs
- [ ] The sandbox guard **skips with a message** when the gateway is unreachable; verified by running
      with the sandbox env unset
- [ ] `coverage.test.ts` passes both alone and in the full suite
- [ ] The secret-scan command reports `no secrets` on a clean tree, and still fires on a planted
      test string (prove it detects, not just that it is quiet)

## Validation Gate

```bash
docker compose config >/dev/null && echo compose-ok
npm run test && npm run test          # green twice
git grep -nE "(sk-ant|AKIA|BEGIN (RSA|OPENSSH) PRIVATE)" -- . ":!.github/plan/*" && echo "SECRET LEAK" || echo "no secrets"
```

- [ ] All three clean from a fresh checkout
