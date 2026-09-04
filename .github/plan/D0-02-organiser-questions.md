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
3. ~~**Category confirmation.**~~ **RESOLVED 2026-09-04, no call needed.** The submission Google
   Form (linked in the portal nav only when logged in) offers exactly two categories:
   `Academic, Research & DPIIT Recognised Startup / Individual Participant` and
   `Industry & Established Enterprise`. **"Individual Participant" is explicitly Category 1**, so a
   solo professional competes for the ₹4,00,000 first prize.
4. **Are the sandbox RTSP endpoints reachable from a datacenter IP?** Partially moot — the sandbox
   turned out to be **HLS-only on `cctv.corp8.cloud`**, ordinary cloud infrastructure behind
   Cloudflare, so a rented GPU will very likely reach it. Still test empirically.

5. **WHICH MODEL NUMBERING IS AUTHORITATIVE — `/problems` or `/evaluation-criteria`?**
   *(highest priority — this decides what we submit under)*
   The two pages contradict each other. `/problems` calls Model 3 *"VMS Federation & Middleware
   Integration"* (software). The unlinked `/evaluation-criteria` page scores Model 3 as **hardware**
   — *"the transponder/encoder must be… suitable for field deployment"*, secure boot, PoE, rugged
   design. We have switched to **Model 1 + Model 4** on the basis of the scored rubric. Confirm.

6. **Does a separate RTSP / live environment open for evaluation?**
   The published Integrator's Guide describes RTSP `:8554` and WHEP `:8889`; neither exists on the
   deployed sandbox, which serves **VOD HLS**. If a live RTSP environment appears on the day and we
   built HLS-only, the test case fails. If it never appears, we stop building for it. Either answer
   is actionable — not knowing is the risk.

## Acceptance Criteria

- [ ] Q1 answered; if a document exists, it is downloaded to `docs/official/` and **`PROJECT.md` is
      reconciled against it**, with any deltas logged to `BL-01`
- [ ] Q2 answered and recorded
- [x] Q3 **resolved** via the submission form — Individual Participant = Category 1
- [ ] Q5 answered — **the model-numbering question outranks all others**
- [ ] Q6 answered — RTSP/live environment for evaluation, yes or no
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
