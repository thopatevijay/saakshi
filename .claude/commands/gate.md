---
description: Run a SAAKSHI day-gate verification — proves a milestone is truly complete before the next starts
argument-hint: <gate-ticket-id>   e.g. /gate D1-GATE
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# /gate — verify a day is genuinely done

Gate: **$ARGUMENTS**

## Why gates are hard stops

Day 1 exists to make one path work end to end. Day 2 builds the graded scoring loop on top of it.
Day 3 adds differentiators. **Each day assumes the previous one actually works.** A gate that is
waved through converts a 4-day plan into a broken demo on day 4, and there is no recovery time.

## Steps

1. Resolve the gate ticket and read it in full, including comments:
   ```bash
   cd "$(git rev-parse --show-toplevel)"
   python3 -c "import json;print(json.load(open('.github/plan/issue-map.json'))['$ARGUMENTS'])"
   gh issue view <n> -R thopatevijay/saakshi --comments
   ```

2. Confirm **every** ticket in the gate's `blocked_by` list is closed. List any that are not.
   An open non-bonus blocker means the gate cannot pass — report and stop.
   Bonus tickets (`D3-03`, `D3-09`, `D3-10`) may be *closed as deferred* rather than done; that is
   acceptable, but the deferral must exist as a closed issue with a roadmap entry.

3. Run the gate's Validation Gate block **from a clean state**, verbatim. Clean state means what the
   ticket says — usually `docker compose up` from scratch plus migrations plus seed. Do not reuse a
   warm environment; the point is to prove reproducibility.

4. Walk every Acceptance Criterion and record `PASS — <evidence>` or `FAIL — <why>`.
   Evidence is command output, a test name, a committed screenshot, or a queried row count.

5. Capture whatever the gate requires: screenshots to `docs/screenshots/`, measured numbers, counts.

6. Post the result as a comment on the gate issue — the numbers table the ticket asks for, plus the
   AC results. This comment is what a future session reads to know the day genuinely closed.

7. If **PASS**: close the gate issue with `status:done`, then report the next day's first
   `/start` command.
   If **FAIL**: leave it open, label `status:blocked`, list exactly which ACs failed and what must
   happen. **Do not open next-day tickets.** Log the cause to `BL-01`.

## Do not

- Do not pass a gate on the strength of code that looks correct. Gates are empirical.
- Do not defer a *non-bonus* AC to "later" — later is the deadline.
- Do not skip the clean-state requirement. A demo that only works on your warm machine will fail on
  stage, which is precisely what the gates exist to prevent.
