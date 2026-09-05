---
title: "D2-11 · Plate crops reach the object store, and no path ever signs a URI it cannot serve"
milestone: "Day 2 — Analytics & Alert Core"
labels: ["day-2", "backend", "pillar-4", "bug"]
blocked_by: ["D2-01", "D2-02", "D2-06"]
estimate: "1h"
---

## Context

The D2-GATE re-run passed 9 of 10 acceptance criteria. The one failure is AC 5's *"alert in the UI
within 10 s, **with crop** and 'why'"*: the alert arrives with a complete why-payload, and its crop
link **returns HTTP 400**.

Two defects underneath, and they compound.

**1 · Nobody uploads plate crops to the object store.** D2-01's `LocalCropStore` writes them to the
local filesystem. Its own `--crop-dir` help text says *"gitignored; **D2-02 replaces this with
MinIO**"* — and D2-02 migrated **vehicle** crops only.

```
sightings.crop_uri     s3://... 1106      file://... 0     <- D2-02's path, correct
plate_reads.crop_uri   file:///Users/.../evidence/plates/.../100-plate.jpg
find evidence/plates -name '*-plate.jpg' | wc -l   ->   24
```

**2 · The alert path presigns any string. The trace path refuses to.** Handed that `file://` URI, the
alert signed the whole thing as an S3 object key:

```
cropUrl: http://localhost:9000/saakshi-evidence/file%3A///Users/vijay/.../100-plate.jpg?X-Amz-...
curl    ->  HTTP 400
```

`packages/api/src/services/crop-url.ts` already contains the correct behaviour, and **the trace path
uses it** — returning `cropUrl: null` for the identical input, which D2-07 renders as a first-class
"no crop stored" state. One concept, two consumers, one of them unguarded.

**Defect 2 is the more serious in kind.** `null` renders as an honest "no crop stored". A signed link
that fails looks real and is not — exactly what `CLAUDE.md`'s claims discipline exists to prevent,
and exactly the sort of thing a judge clicks.

This is the third seam defect in D2 (after D2-10's `normalized_text`): ticket A defers to ticket B,
B covers its own half, nobody owns the join.

## Scope

- **Non-negotiable:** no code path presigns a URI it cannot serve. Route the alert's crop through
  `presignerFromEnv` — or the same `s3://<bucket>/` prefix guard — so an unservable URI yields `null`,
  never a signed link. If any other caller presigns, fix it the same way or say why it is safe.
- **Make the crop actually render:** plate crops must reach the object store, so a live alert carries
  a link that resolves. Prefer reusing D2-02's evidence path rather than writing a second uploader —
  it already handles the bucket, the key convention `evidence/<camera>/<yyyy-mm-dd>/<id>-plate.jpg`,
  the retention rules and the presign semantics.
- **Keep the local path working as a fallback.** With no object store configured, the honest answer
  is still `null` → "no crop stored". Do not make MinIO a hard requirement for the pipeline to run.

## Out of scope

- Changing what a crop *is*, when it is taken, or best-shot selection. D2-02 owns that.
- Changing the alert engine's severity, dedupe or why-payload beyond the crop field.
- Retro-uploading the 24 existing local crops. If you do it, make it a separate labelled step —
  the fix is the write path, and a backfill hides whether it works.

## Acceptance Criteria

- [ ] **No path emits a presigned URL for a URI it cannot serve.** Asserted by name for a `file://`
      input on **both** the alert and trace paths — same input, same answer, and that answer is `null`
- [ ] A live alert's `reason.evidence.cropUrl` either resolves (**HTTP 200**, correct content type)
      or is `null` — never a URL that 4xxs. Proven with a real request, not a unit stub
- [ ] Plate crops written by the pipeline land in the object store, verified by listing it — not only
      by a row in the database
- [ ] With the object store unconfigured, the pipeline still runs and the crop renders as
      "no crop stored" — the fallback is asserted
- [ ] **The cross-seam regression test**, in the spirit of D2-10's: an alert raised through the real
      correlation path carries a crop link that a real HTTP request can fetch, or an explicit `null`.
      One assertion spanning the writer and the reader
- [ ] No existing AC of D2-01, D2-02, D2-06, D2-07 or D2-08 regresses; suite counts do not fall
- [ ] `docs/alerting.md` (or the evidence doc) states which store holds plate crops and what `null`
      means, so the next ticket does not re-derive it

## Validation Gate

```bash
npm run typecheck && npm run lint && npm run format:check
npm run test
pytest workers -q
psql "$DATABASE_URL" -c "select count(*) filter (where crop_uri like 's3://%') as s3, count(*) filter (where crop_uri like 'file://%') as local from plate_reads;"
```

- [ ] Full suite green, with the cross-seam assertion in it
- [ ] A comment on this issue stating: where plate crops now live, the guard's behaviour on a
      non-servable URI, and the HTTP status of a real presigned alert crop

## Handoff → D2-GATE, D3-04, D4-03

`D2-GATE` re-runs after this. State plainly whether AC 5's "with crop" is satisfied, and give the
exact request a future session can use to check that an alert's crop link resolves.
