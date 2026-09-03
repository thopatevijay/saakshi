---
title: "D4-06 · Model 1 document deliverables and department onboarding questionnaire"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "docs", "model-1-deliverable", "scored-dimension"]
blocked_by: ["D1-02", "D3-06"]
estimate: "2h"
---

## Context

Two easy, scored things almost every team will skip.

**Model 1 explicitly names five deliverables**, two of which are documents: *registry API
documentation* and a *sample gap-analysis report*. And Step 3's ten design dimensions include
**"Department-wise Information Requirements"** — what we need *from each department* to assess
integration feasibility. That is a questionnaire. Nobody will write it. It is scored.

## Scope

**A. Registry API documentation** (`docs/registry-api.md` — started in D1-02, finished here)
Complete enough for a third party to onboard cameras without asking us a question: auth, all
endpoints, request/response schemas, error codes, bulk CSV column spec, rate limits, worked curl
examples.

**B. Sample gap-analysis report** (`docs/gap-analysis-sample.md` — generated in D3-06)
Verify it is generated from live data, includes the trusted-vs-all delta, and states its method.

**C. Department onboarding questionnaire** (`docs/department-onboarding-questionnaire.md`)
The real artefact a state IT team would send to 26 departments. Per department, per site:
- Camera inventory: count, make/model, analog vs IP, resolution, codec, PTZ, install year
- Network: connectivity type, bandwidth, static IP/NAT, firewall ownership, VLAN
- VMS/NVR: vendor, version, API/SDK availability, licence terms, AMC expiry, vendor contact
- Storage: location, capacity, **retention days**, cloud vs local
- Access: who authorises feed sharing, existing MoU/data-sharing status
- Geo: coordinates, bearing, FOV, mounting height (inputs to our coverage model)
- Constraints: privacy-sensitive locations, restricted-viewing cameras, legal limitations
- Contacts: technical owner, administrative owner, escalation

Delivered as both a fillable CSV/spreadsheet template **and** the prose rationale for each field
(*why* we ask, and what it unblocks). Wire the CSV into the D1-02 bulk-import format so a returned
questionnaire imports directly — that closes the loop from paperwork to onboarded camera.

## Acceptance Criteria

- [ ] `docs/registry-api.md` complete; every endpoint has a working curl example (each verified)
- [ ] Bulk CSV column spec documented and matching the actual parser (verified by importing the
      questionnaire template itself)
- [ ] `docs/gap-analysis-sample.md` present, generated, with the trusted-vs-all delta and method
- [ ] Questionnaire covers all eight field groups above
- [ ] Fillable template provided (`fixtures/department-onboarding-template.csv`)
- [ ] **Template round-trips**: filling it and importing it creates cameras with coverage metadata
- [ ] Each field has a stated rationale
- [ ] All three documents referenced from `docs/HLD.md` and the deck

## Deliverables

- `docs/registry-api.md`
- `docs/gap-analysis-sample.md` (+ PDF)
- `docs/department-onboarding-questionnaire.md`
- `fixtures/department-onboarding-template.csv`

## Validation Gate

```bash
npm run docs:verify-curl -- docs/registry-api.md    # executes every documented example
curl -fsS -XPOST localhost:4000/api/v1/cameras/bulk -F file=@fixtures/department-onboarding-template-filled.csv
test -s docs/gap-analysis-sample.md && test -s docs/department-onboarding-questionnaire.md
```

- [ ] Every documented curl example executes successfully
- [ ] Filled template imports cleanly and produces coverage metadata

## Handoff → D4-04, D4-05

The questionnaire **is** the "Department-wise Information Requirements" dimension. Reference it
directly in both the deck and the HLD rather than restating it.
