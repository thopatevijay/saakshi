---
description: Log a bug, gap, pitfall or constraint to the SAAKSHI backlog issue (BL-01)
argument-hint: <what you found>   e.g. /backlog night feeds produce almost no plate reads
allowed-tools: Bash, Read, Grep
---

# /backlog — log a finding without derailing the ticket in flight

Finding: **$ARGUMENTS**

## Why this exists

During a 4-day build, every discovered problem is a fork in the road: fix it now and lose the
ticket, or forget it and lose the finding. This is the third option.

At submission time `BL-01` is triaged by `D4-08` into two scored assets: the deck's *"What this
system does not do"* slide and the *Future Roadmap* dimension. **A limitation found and stated is a
strength; the same limitation found by a judge is a hole.** So logging is not bookkeeping — it is
producing a deliverable.

## Steps

1. Resolve the backlog issue number:
   ```bash
   cd "$(git rev-parse --show-toplevel)"
   python3 -c "import json;print(json.load(open('.github/plan/issue-map.json'))['BL-01'])"
   ```

2. Establish where the finding came from — the current branch names the ticket:
   ```bash
   git branch --show-current
   ```

3. Classify it. Pick exactly one:
   `bug` · `gap` · `pitfall` · `constraint` · `assumption-wrong` · `perf` · `security` · `data-quality`

4. Apply the **triage rule** and act accordingly:
   - **Blocks the current ticket's AC** -> fix it now, and still log it here.
   - **Breaks a later ticket** -> log here, *and* post a `blocker` comment on that ticket so a
     future session sees it before starting.
   - **Neither** -> log and defer. Do not touch it.

5. Post the entry:
   ```bash
   gh issue comment <BL-01 number> -R thopatevijay/saakshi --body "$(cat <<'EOF'
### <YYYY-MM-DD HH:MM> · found in <TICKET-ID> · <type>
**What:**        <one line>
**Impact:**      <what breaks or is at risk>
**Workaround:**  <what we did instead, or "none — deferred">
**Action:**      <fix now | fix Day 4 | accept as limitation | document in HLD>
EOF
)"
   ```

6. If the finding invalidates something written in `PROJECT.md`, **correct `PROJECT.md` in the same
   commit as the current ticket's work.** A stale spec is worse than no spec — later sessions trust it.

7. Confirm to the user in one line: what was logged, its type, and its action.

## Do not

- Do not fix out-of-scope findings inline. That is how a 4-day plan becomes a 9-day plan.
- Do not log vague notes ("perf could be better"). If it is not specific enough to triage, it is not
  a finding yet — investigate or drop it.
