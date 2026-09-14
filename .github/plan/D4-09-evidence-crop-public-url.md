---
title: "D4-09 · Every evidence crop is a broken image for a judge — presigned URLs are signed against the private host"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "bug", "deploy", "critical", "submission"]
blocked_by: []
estimate: "1.5h"
---

## Context

Found in D4-01 (BL-01 finding 18), confirmed on `main` on 14 Sep.

On the deployment `MINIO_ENDPOINT=http://minio.railway.internal:9000`. `evidenceStoreFromEnv`
(`packages/api/src/services/evidence.ts:412`) signs every presigned URL against that value, and
`packages/web/src/lib/alerts/present.ts` puts the result straight into an `<img src>`. A judge's
browser cannot resolve `minio.railway.internal`, so **every evidence crop on the hosted demo is a
broken image**.

This is the worst open defect for submission. The hosted URL is a submission item, chain of custody
is the project's central claim, and a broken crop on the alert queue is the first thing a judge sees
after the wall.

**There is no public-endpoint variable today** — `grep MINIO_PUBLIC` returns nothing. SigV4 binds the
`Host` header, so the signing host and the browser-facing host must be identical. Adding a second
variable is therefore a real change, not a config tweak.

## Scope

Pick one and implement it fully:

**Option A — proxy objects through the web BFF (preferred).** The web app is already a BFF: every
API call is server-side with an httpOnly cookie (BL-01 finding 6). A route that streams the object
server-side keeps the object store private, needs no new public surface, and works identically on
Railway and in compose. Costs a hop per crop.

**Option B — a public MinIO endpoint.** Publish MinIO's S3 port, add `MINIO_PUBLIC_ENDPOINT`, sign
against it when set and fall back to `MINIO_ENDPOINT` when not. Direct, but widens the deployment's
public surface and needs the bucket policy checked.

Whichever is chosen, state why in the PR body — D4-05's HLD has to describe the evidence path.

## Acceptance Criteria

- [ ] A crop URL rendered on the **deployed** `/alerts` loads in a browser with no Railway-internal
      hostname anywhere in it — evidenced by the resolved URL and an HTTP 200 with `image/*`
- [ ] The same path works unchanged in local compose (`MINIO_ENDPOINT=http://localhost:9000`)
- [ ] Signature verification still passes — a tampered or expired URL is still rejected
- [ ] `packages/api/src/services/evidence.test.ts` extended to cover the public/private split
- [ ] No presigned URL is ever minted for an object the caller may not read (the D2-11 rule holds)
- [ ] `.env.example` updated if a new key is introduced

## Validation Gate

```bash
npm run test -w @saakshi/api -- evidence
curl -sI "$(<resolved crop url>)" | head -3      # 200 + image/*
```

- [ ] A judge-reachable crop URL returns an image from the deployed instance
