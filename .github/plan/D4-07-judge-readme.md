---
title: "D4-07 · Judge-facing README and public repository"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "docs", "submission"]
blocked_by: ["D4-01"]
estimate: "1.5h"
---

## Context

Submissions may include *"a GitHub or GitLab repository link containing the platform source code"*.
A reviewer will spend perhaps three minutes in the repo. The README decides what they conclude.

Written for judges, not for contributors: **problem → solution → what is real → how to run.**

## Scope

- What it is, in three sentences, above the fold
- The problem, in the department's own terms (26 silos, 80k cameras, 7–15 day retention)
- Model choice (1 + 3) with the one-line justification
- Architecture diagram inline
- **What is real vs what is specified** — an explicit table. Live: ANPR, trust scoring, alerting,
  trace, audit chain. Specified-not-live: VAHAN/eGujCop connectors. Out of scope by choice: FRS.
  This table is the single most credibility-building thing in the README.
- Measured numbers with links to how they were measured
- Quickstart that actually works from a clean clone: `docker compose up` → migrate → seed → run
- Live demo URL + how to request credentials
- Repo map: what lives where
- Licence, and third-party model licences (`docs/model-licences.md`)

## Acceptance Criteria

- [ ] Quickstart verified **from a fresh clone in a clean directory** by following it literally,
      copy-pasting each command — no undocumented step, no missing dependency
- [ ] Architecture diagram renders on GitHub
- [ ] Real-vs-specified table present and accurate
- [ ] Every measured number links to its source doc or ticket
- [ ] Live demo URL correct and loading
- [ ] `.env.example` in sync with what the code actually reads (verified programmatically)
- [ ] **Repository made public**; a logged-out browser can view it
- [ ] No secrets in the repo or in any commit in history (history scanned, not just HEAD)
- [ ] `LICENSE` present; model licences documented

## Deliverables

- `README.md`
- `docs/model-licences.md`
- Public repo at https://github.com/thopatevijay/saakshi

## Validation Gate

```bash
cd $(mktemp -d) && git clone https://github.com/thopatevijay/saakshi && cd saakshi
# follow README quickstart literally, copy-paste only:
docker compose up -d && npm install && npm run db:migrate && npm run seed:demo-state && npm run dev
curl -fsS localhost:4000/health && curl -fsSI localhost:3000 | head -1
# secret history scan:
git log -p --all | grep -nE "(sk-ant|AKIA|BEGIN (RSA|OPENSSH) PRIVATE)" && echo LEAK || echo clean
node scripts/check-env-sync.js     # .env.example vs process.env reads
```

- [ ] Clean-clone quickstart succeeds with zero manual deviation
- [ ] History secret scan clean
- [ ] `.env.example` sync check passes
- [ ] Repo publicly viewable while logged out

## Handoff → D4-SUBMIT

The repo URL goes in the submission form. Confirm it is public **before** submitting, not after.
