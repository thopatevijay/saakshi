---
title: "D3-GATE · Day 3 gate: differentiators demonstrable"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "gate"]
blocked_by: ["D3-01","D3-02","D3-04","D3-05","D3-06","D3-07","D3-08","D3-11"]
estimate: "1h"
---

## Purpose

**Do not start Day 4 until this passes.** Day 4 is deployment and submission writing — it assumes the
product is feature-complete and every number we intend to print is measured.

`D3-03` (re-ID), `D3-09` (NL query) and `D3-10` (observability) are bonus. If any is deferred, close
it as deferred with a reason, log to `BL-01`, and put it in the roadmap — do **not** block this gate
on them.

## Acceptance Criteria

- [ ] Route reconstruction renders observed vs inferred unmistakably
- [ ] Impossible-transition detection runs over real data with an honest interpretation recorded
- [ ] Audit chain verifies; tamper test detects; export bundle verifies and fails on a byte change
- [ ] Retention clock answers a real location+time query
- [ ] Gap-analysis report generated from live data, including the trusted-vs-all coverage delta
- [ ] Video wall runs a 3×3 grid cleanly with no leaked connections
- [ ] Sizing calculator reproduces (or corrects) the `PROJECT.md §9` figures from **measured** inputs
- [ ] Own-feed demo video recorded, uploaded unlisted, URL recorded
- [ ] Bonus tickets either done or explicitly closed as deferred with a roadmap entry
- [ ] `npm run typecheck && npm run lint && npm run test` green; `pytest workers -q` green
- [ ] Every number we intend to print in the deck is traceable to a ticket comment
- [ ] `BL-01` fully up to date

## Validation Gate

```bash
npm run typecheck && npm run lint && npm run test && pytest workers -q
npm run audit:verify && npm run export:verify -- ./exports/<latest>
npm run report:gap-analysis && npm run export:sizing -- --scenario statewide
npm run build -w packages/web
```

- [ ] All green
- [ ] `docs/screenshots/` holds every image the deck needs
- [ ] A comment listing every headline number with its source ticket

## Handoff → Day 4

Freeze features here. Day 4 changes are bug fixes and documents only — anything else goes to `BL-01`
and the roadmap.
