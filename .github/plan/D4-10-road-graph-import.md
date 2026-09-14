---
title: "D4-10 · The road graph is empty, so two differentiators and a compulsory deliverable cannot run"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "bug", "data", "critical", "model-1-deliverable", "submission"]
blocked_by: []
estimate: "1.5h"
---

## Context

Found in D4-02 (BL-01 finding 21). `road_network` is empty **in the deployed database and in local
development**, because `scripts/import-osm.sh` has never been run. The script exists and is
executable; nothing has invoked it.

Three things fail closed as a result — all of them honestly, which is to their credit, but all of
them unusable in the submission:

| Command | Current output |
|---|---|
| `analyze:anomalies` | *"10 transitions were examined and NONE could be assessed… '0 impossible transitions' here means '0 transitions were testable', not 'the estate is clean'."* |
| `report:gap-analysis` | *"road_network is empty — nothing to compute coverage against"* |
| D3-02 cloned-plate detection | demonstrable only from `docs/cloning-detection.md` |

**Why this blocks submission, not just the demo.** The sample gap-analysis report is one of Model 1's
five named deliverables. `docs/gap-analysis-sample.pdf` is committed, but it **cannot currently be
regenerated** — so if a judge asks how it was produced, the answer is a script that errors out.
Impossible-transition detection is the headline Pillar-3 differentiator and D4-04's deck slide.

Affects **D4-03, D4-04, D4-06 and D4-SUBMIT**.

## Scope

- Run `scripts/import-osm.sh` for the Gujarat extract against the local database; fix whatever it
  hits on first real use (it has never been exercised end to end)
- Verify `road_network` is populated and GiST-indexed, with a row count
- Re-run `analyze:anomalies` and confirm transitions are now **assessable** — a real verdict, whether
  that verdict is zero impossible transitions or more
- Re-run `report:gap-analysis` and regenerate `docs/gap-analysis-sample.{md,pdf}` from live data
- Apply the same import to the **deployed** database so the hosted demo matches
- Record the extract used, its date and the row count in the report, so the number is reproducible

## Acceptance Criteria

- [ ] `select count(*) from road_network` returns a non-zero count, stated in the PR body
- [ ] `analyze:anomalies` reports transitions **examined and assessed**, not "none testable"
- [ ] `report:gap-analysis` exits 0 and writes a report with real coverage figures
- [ ] `docs/gap-analysis-sample.md` regenerated from that run, superseding the committed artifact
- [ ] The deployed database carries the same graph — verified by row count against the deployment
- [ ] If the estate genuinely has zero impossible transitions, that is reported as a **measured**
      result with the number of transitions tested — never as "detection works, see the doc"

## Validation Gate

```bash
psql "$DATABASE_URL" -c "select count(*) from road_network;"
npm run analyze:anomalies
npm run report:gap-analysis
```

- [ ] All three produce real numbers from a clean run
