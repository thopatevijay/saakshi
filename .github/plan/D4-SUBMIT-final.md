---
title: "D4-SUBMIT · Final submission gate — submit by midday 7 Sep"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "gate", "submission", "critical"]
blocked_by: ["D4-01","D4-02","D4-03","D4-04","D4-05","D4-06","D4-07","D4-08"]
estimate: "2h"
---

## Context

**Registration and submission both close 7 September 2026.**

Submit in the **morning**. Government portals fail at 23:00 on deadline day, and there is no appeal.
A submission at 11:00 with one rough edge beats a perfect one that never uploads.

## Pre-submission checklist — every required artefact

- [ ] **Solution Presentation** (PPT/PDF) — `submission/saakshi-solution-deck.pdf`
- [ ] **Technical Proposal / HLD** — `submission/saakshi-hld.pdf`
- [ ] **Own-feed demo video** — unlisted YouTube URL (D3-11)
- [ ] **Government-feed demo video** — unlisted YouTube URL (D4-03)
- [ ] **Output report** — `submission/govt-feed-output-report.{csv,pdf}` (D4-03)
- [ ] **Hosted platform URL + test credentials** (D4-01, D4-02)
- [ ] **Public repository URL** (D4-07)

## Consistency checks — do these before uploading anything

- [ ] Measured ANPR accuracy is **identical** in the deck, the HLD, and the output report
- [ ] Model choice is stated identically in the deck, the HLD, and the submission form, and matches
      the official numbering resolved in D0-02 Q1
- [ ] No artefact claims live VAHAN/eGujCop/AFIS/NAFIS connectivity
- [ ] No artefact implies face recognition is implemented
- [ ] Any deferred bonus feature appears as roadmap, never as a current capability
- [ ] All ten mandatory design dimensions are present and labelled in the deck
- [ ] Every HLD bullet from the `/problems` page is addressed under a matching heading

## Access checks — from a clean, logged-out browser on a different network

- [ ] Both YouTube URLs load while logged out and are set to **Unlisted** (not Private)
- [ ] Any Drive/OneDrive link is set to "Anyone with the link — Viewer"
- [ ] Hosted URL loads and the judge credentials work
- [ ] Repository is publicly viewable
- [ ] All PDFs open and are within any portal upload size limit

## Safety checks

- [ ] No credentials, tokens, or PII in any video frame (frame-by-frame review done)
- [ ] No secrets anywhere in git history
- [ ] Output report contains no data we are not entitled to publish

## Submission

- [ ] Every portal field completed
- [ ] Every link pasted from `.dev-refs.md`, **not retyped from memory**
- [ ] **Submitted before 13:00 IST on 7 Sep**
- [ ] Confirmation screenshot / acknowledgement email saved to `submission/`
- [ ] A comment on this issue recording the submission timestamp and every submitted link

## Post-submission

- [ ] Keep the deployed instance up and the workers running through 11 Sep
- [ ] Shortlist announcement is 7 Sep **evening** — watch email and the portal
- [ ] If shortlisted: travel to Gandhinagar for 10–11 Sep. Only ~2.5 days of notice, so have the
      decision and the logistics already settled.
- [ ] Prepare the Phase 2 story: what the ₹18L Phase 1 grant would build, straight from `docs/roadmap.md`

## Validation Gate

```bash
ls -la submission/
# from a clean incognito session on a different network, open in turn:
#   both YouTube URLs · the hosted URL (log in as a judge) · the public repo
```

- [ ] Every artefact present in `submission/`
- [ ] Every external link verified from outside our network
- [ ] Submission confirmation saved
