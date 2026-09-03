---
title: "D2-02 · Vehicle attributes and evidence store"
milestone: "Day 2 — Analytics & Alert Core"
labels: ["day-2", "cv", "backend", "pillar-3", "pillar-4"]
blocked_by: ["D1-09"]
estimate: "2h"
---

## Context

Attributes let a query work when the plate does not ("white hatchback near X"). Deliberately kept
**cheap and honest**: colour from an HSV histogram, body type from the detector class. We do not
claim make/model here — D3-03 handles the harder identity work.

Evidence crops are what make an alert verifiable in three seconds, and what make an export
defensible later.

## Scope

- Vehicle colour: HSV histogram over the vehicle box interior with a documented palette mapping
  (white/silver/grey/black/red/blue/yellow/green/brown/other) + a confidence
- Body type: from the detector class (car/truck/bus/motorcycle/auto-rickshaw where available)
- Evidence store: MinIO, S3-compatible
  - Path convention `evidence/<camera_id>/<yyyy-mm-dd>/<sighting_id>-{vehicle,plate}.jpg`
  - **Store crops only for best-shots and watchlist hits** — not every frame. This is the storage
    argument in the sizing model: unbounded crop storage is what makes naive designs unaffordable.
  - Retention policy per bucket prefix, configurable
- Signed-URL access; no public bucket

## Acceptance Criteria

- [ ] Colour and body type populated on sightings that have a best-shot
- [ ] Colour palette mapping documented; a fixture test covers ≥ 6 colours
- [ ] Colour confidence emitted; low-confidence reads marked, not silently guessed
- [ ] Crops written **only** for best-shots and watchlist hits — proven by a count test comparing
      sightings to stored objects
- [ ] Signed URLs work and expire; the bucket is not publicly listable (verified)
- [ ] Retention policy configured and documented
- [ ] Measured storage per 1,000 sightings recorded — **input to the sizing model**

## Deliverables

- `workers/analytics/attributes.py`
- `packages/api/src/services/evidence.ts` — put, signed-get, retention
- `docs/evidence-store.md` — path convention, retention, access model, measured storage rates

## Validation Gate

```bash
pytest workers/analytics -q -k attributes
npm run test -w packages/api -- evidence
mc ls local/saakshi-evidence --recursive | wc -l    # or aws-cli equivalent
psql $DATABASE_URL -c "select vehicle_color, count(*) from sightings where vehicle_color is not null group by 1 order by 2 desc;"
curl -fsSI "<signed-url>" | head -1                  # 200
curl -fsSI "http://localhost:9000/saakshi-evidence/" | head -1   # must NOT list
```

- [ ] Object count ≈ best-shot count, not sighting count
- [ ] Public listing denied

## Handoff → D2-06, D3-04

Alerts embed the crop signed URL; export bundles hash the crop bytes.
