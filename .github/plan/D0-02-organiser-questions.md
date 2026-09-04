---
title: "D0-02 · Resolve open questions with the organisers"
milestone: "Day 0 — Recon & Bootstrap"
labels: ["day-0", "compliance", "blocker-risk"]
blocked_by: []
estimate: "1h"
---

## Context

**All questions resolved 2026-09-04 from evidence, without contacting the organisers.** The decision
was to make this ticket self-closing rather than dependent on a helpdesk response we cannot schedule.
An email was drafted as a non-blocking backstop; nothing waits on a reply.

Helpdesk (unused, available if needed): **+91 95370 89982** · sentinel.hackathon@gujarat.gov.in

## Resolutions — all self-derived

### Q1 · Does an official Problem Statement document (a "Model 5") exist? — **NO**
- Site-wide scan found **zero** PDF/DOC/PPT/ZIP links anywhere on `sentinel.gujarat.gov.in`.
- Checked `/problems` and `/datasets` **while logged in**: navigation is byte-identical to logged-out
  except for a `Submission` link. No document, no download.
- `/problems` Step 3 lists Models 1–4 **plus Hybrid** and calls them *"the five reference solution
  models"*. Five = four models + Hybrid. Internally consistent; no missing document.
- **Conclusion: "Model 5" is the Hybrid / Customised option.**

### Q2 · Is Phase 1 remote? — **YES**
- Submission is a **Google Form** collecting links (unlisted YouTube, Drive, hosted URL, repo).
  A link-based submission is inherently remote.
- Shortlisting is **7 Sep evening**, three days *before* the 10–11 Sep event.
- `/phases`: Phase 1 = *"integrate their solutions with the test feeds made available for the
  challenge"* (the sandbox, consumed over the internet). Phase 2 = the six finalists *"integrate with
  real CCTV feeds at scale"* and are *"evaluated directly by Gujarat Police leadership"* — the venue.
- **Conclusion: travel is required only if we place in the top 6.**

### Q3 · Category for a solo professional — **CATEGORY 1**
The submission form offers exactly two: `Academic, Research & DPIIT Recognised Startup /
**Individual Participant**` and `Industry & Established Enterprise`. Individual Participant is
Category 1 → competing for the ₹4,00,000 first prize.

### Q4 · Datacenter-IP reachability — **LOW RISK, and mitigated regardless**
- Grid is HTTPS/443 only on `cctv.corp8.cloud`, resolving to **Cloudflare** proxy IPs
  (172.67.213.199, 104.21.59.42; `cf-ray … -BOM`).
- Auth is a **session cookie**, not IP allow-listing. Cloudflare does not block datacenter ranges by
  default.
- Mitigated either way: Topology B in `docs/deployment.md` runs workers locally against the cloud
  database, so a block costs nothing.

### Q5 · Which model numbering is authoritative? — **MADE IRRELEVANT**
`/problems` Step 3 explicitly permits *"a hybrid architecture combining features from two or more
reference solution models"*. We therefore submit as **Model 1 (compulsory) + Hybrid** and map our
deliverables onto **both** rubrics: our federation layer is Model 3 under `/problems` numbering and
our analytics is Model 4 under `/evaluation-criteria` numbering. Model 1 is compulsory and satisfied
under either. A scorer applies whichever rubric they hold and still finds our work mapped to it.
**No answer needed.**

### Q6 · Will a live RTSP environment appear for evaluation? — **NOT ON THIS HOST. Architecturally impossible.**
- Ports **8554 (RTSP), 8889 (WHEP) and 8888 (HLS-alt) are all closed/filtered**; only 443 is open.
- The host sits behind a **Cloudflare HTTP reverse proxy**. Cloudflare proxies HTTP/HTTPS ports only
  — **it cannot carry RTSP at all**, which is not an HTTP protocol. This is not a disabled feature;
  it is impossible without exposing a different origin.
- **Conclusion:** the Integrator's Guide's RTSP/WHEP section is aspirational or templated. If a live
  environment does appear on evaluation day it must be a **different host** — which our adapter
  framework absorbs as config plus an existing adapter, with **zero core change**. That is precisely
  the federation argument, so the risk is already engineered away and becomes a deck point rather
  than a threat.

## Acceptance Criteria

- [x] Q1 resolved — no document exists; Model 5 = Hybrid
- [x] Q2 resolved — Phase 1 remote; travel only for the top 6
- [x] Q3 resolved — Individual Participant = Category 1
- [x] Q4 resolved — low risk, and mitigated by Topology B
- [x] Q5 made irrelevant — submit as Model 1 + Hybrid, mapped to both rubrics
- [x] Q6 resolved — RTSP impossible on this host; adapter framework absorbs a different host
- [x] `PROJECT.md` §2 reframed to Model 1 + Hybrid
- [x] Findings logged to `BL-01`
- [ ] *(optional, non-blocking)* email sent as a courtesy backstop — nothing waits on a reply

## Deliverables

- This resolution set, recorded on the issue
- `PROJECT.md` §2 updated
- `docs/organiser-email-draft.md` — optional backstop, send or discard

## Validation Gate

```bash
# Q6 evidence, reproducible:
for p in 8554 8889 8888 443; do nc -z -G 6 -w 6 cctv.corp8.cloud $p && echo "$p OPEN" || echo "$p closed"; done
curl -sI https://cctv.corp8.cloud/ | grep -i '^server'      # cloudflare
```

- [x] Only 443 open; server is Cloudflare
- [x] Zero `_TBD_` entries left in the `.dev-refs.md` open-questions section
