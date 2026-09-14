---
title: "D4-SUBMIT · Final submission gate — submit by midday 15 Sep"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "gate", "submission", "critical"]
blocked_by: ["D4-01","D4-02","D4-03","D4-04","D4-05","D4-06","D4-07","D4-08"]
estimate: "2h"
---

## Context

**Registration and submission both close 15 September 2026.**

> **This ticket said 7 September until 14 Sep 2026.** The organisers extended the deadline — the
> portal labels it "NEW DEADLINE" — and `PROJECT.md` and `CLAUDE.md` were updated while this file was
> not. It is the one document most likely to be read under pressure on the morning itself, so the
> correction is recorded here rather than only in the commit.
>
> **No time of day is published.** The portal states a date and nothing else. The 13:00 IST gate
> below is ours, for the reason in the next paragraph.

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

**The channel is a Google Form, not a portal upload.** The link appears in the portal navigation
only when logged in:
`docs.google.com/forms/d/e/1FAIpQLSeK7bCJ67zyZCF-73iAfRbMUXHtGbYKS5Cz8IgP-ZzQYZLJpw/viewform`

It is **multi-page**. Page 1 is email + participant category
(`Academic, Research & DPIIT Recognised Startup / Individual Participant` — that is us). Later pages
are unwalked by design.

- [ ] **Walk the full form early on 15 Sep — before assembling final links — and record every field.**
      Discovering a required field at 11:00 on deadline day is an avoidable failure.
- [ ] Google Forms has no draft-save: have every link in a scratch file and paste in one pass
- [ ] Every form field completed
- [ ] Every link pasted from `.dev-refs.md`, **not retyped from memory**
- [ ] **Submitted before 13:00 IST on 15 Sep**
- [ ] Confirmation screenshot / acknowledgement email saved to `submission/`
- [ ] A comment on this issue recording the submission timestamp and every submitted link

## Post-submission

- [ ] Keep the deployed instance up and the workers running through **23 Sep** — the judge-facing URL
      is a submitted artefact, and it has to survive screening *and* the Grand Finale, not just the
      submission day. This said "11 Sep", the results date under the original schedule.
- [ ] Shortlist announcement is 15 Sep **evening** — watch email and the portal
- [ ] If shortlisted: travel to Gandhinagar for the Grand Finale, **22–23 Sep**. The extension turned
      ~2.5 days of notice into roughly a week, but have the
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
