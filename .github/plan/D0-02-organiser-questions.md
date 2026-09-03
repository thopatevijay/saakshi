---
title: "D0-02 · Resolve open questions with the organisers"
milestone: "Day 0 — Recon & Bootstrap"
labels: ["day-0", "compliance", "blocker-risk"]
blocked_by: []
estimate: "1h"
---

## Context

Four unknowns materially affect compliance and logistics. All are answerable by one phone call and
one look at the logged-in Resources page.

Helpdesk: **+91 95370 89982** · sentinel.hackathon@gujarat.gov.in · Mon–Sat 10:00–18:00

## Scope

1. **Does an official Problem Statement document exist behind the login?**
   The public `/problems` page references *"five reference solution models"* and *"Reference Model
   1–5"*, but only Models 1–4 plus Hybrid are described, and **no PDF exists anywhere on the public
   site**. Either Hybrid = Model 5, or there is a document we have not read. A non-compliant
   submission is a total loss, so this must be settled.
2. **Is Phase 1 remote?** Confirm in-person attendance at i-Hub Gandhinagar applies only to the
   top 6 finalists on 10–11 Sep.
3. **Category confirmation.** Confirm a solo *Professional* is scored in **Category 1**
   (₹4L/₹2L/₹1L) and not pushed into Category 2 against system integrators. FAQ #44 lists Cat 1 as
   students/graduates/scholars/academic teams/DPIIT startups and omits "professionals", while the
   homepage and the registration form both list professionals.
4. **Are the sandbox RTSP endpoints reachable from a datacenter IP?** Government networks routinely
   block those ranges. This decides whether a cloud GPU is usable at all.

## Acceptance Criteria

- [ ] Q1 answered; if a document exists, it is downloaded to `docs/official/` and **`PROJECT.md` is
      reconciled against it**, with any deltas logged to `BL-01`
- [ ] Q2 answered and recorded
- [ ] Q3 answered and recorded
- [ ] Q4 tested empirically, not assumed: run `scripts/recon.py --only <one-id> --seconds 5` from a
      cloud box (any cheap India-region VM) and record pass/fail
- [ ] All four answers posted as a comment on this issue, with date and who said it

## Deliverables

- Comment on this issue with all four answers
- `docs/official/` populated if a document exists
- `PROJECT.md` §0 updated to replace inference with confirmed fact

## Validation Gate

- [ ] Zero remaining `_TBD_` entries in the `.dev-refs.md` "Open questions" section
- [ ] If a Model 5 exists: a written statement in `docs/HLD.md` of which model we are submitting
      under, matching the official numbering

## Handoff → all tickets

Q1 can change scope. Do not start D1 until Q1 is answered.
