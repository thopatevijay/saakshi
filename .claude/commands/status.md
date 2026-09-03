---
description: Reconstruct SAAKSHI project state from GitHub — what is done, in flight, blocked, next
allowed-tools: Bash, Read, Grep
---

# /status — where the project actually stands

Assume **no prior context**. Rebuild the picture from GitHub and git alone, then report it.
This command is what makes a fresh session productive in under a minute.

## Gather

```bash
cd "$(git rev-parse --show-toplevel)"

echo "=== MILESTONES ==="
gh api repos/thopatevijay/saakshi/milestones?state=all --jq \
  '.[]|"\(.title): \(.closed_issues)/\(.open_issues + .closed_issues) closed · due \(.due_on[0:10])"'

echo "=== IN FLIGHT ==="
gh issue list -R thopatevijay/saakshi --label "status:in-progress" \
  --json number,title --jq '.[]|"#\(.number) \(.title)"'

echo "=== BLOCKED ==="
gh issue list -R thopatevijay/saakshi --label "status:blocked" \
  --json number,title --jq '.[]|"#\(.number) \(.title)"'

echo "=== OPEN, BY MILESTONE ==="
gh issue list -R thopatevijay/saakshi --state open --limit 60 \
  --json number,title,milestone,labels \
  --jq 'sort_by(.milestone.title, .number)[]|"\(.milestone.title // "—")  #\(.number)  \(.title)"'

echo "=== RECENTLY CLOSED ==="
gh issue list -R thopatevijay/saakshi --state closed --limit 12 \
  --json number,title,closedAt --jq 'sort_by(.closedAt)|reverse[]|"#\(.number) \(.title)"'

echo "=== BACKLOG SIZE ==="
gh issue view $(python3 -c "import json;print(json.load(open('.github/plan/issue-map.json'))['BL-01'])") \
  -R thopatevijay/saakshi --json comments --jq '.comments|length'

echo "=== GIT ==="
git branch --show-current; git status --short
git log --oneline -12
git branch -r --list 'origin/feat/*'      # abandoned WIP branches?

echo "=== LOCAL PRPs (interrupted work) ==="
ls -la .prp/ 2>/dev/null || echo "none"
```

## Report

Produce a short, decision-oriented summary:

1. **Day / milestone position** vs the calendar. The deadline is **7 Sep 2026**, submission by
   midday. State whether we are ahead, on track, or behind — and by how much.
2. **In flight** — anything with `status:in-progress`. If a PRP exists in `.prp/` for a ticket that
   is not in flight, that is interrupted work: say so and recommend resuming it.
3. **Blocked** — each one, with what would unblock it (read the blocked comment).
4. **Next up** — the lowest-numbered open ticket whose blockers are all closed. Give the exact
   command: `/start <TICKET-ID>`.
5. **Gate status** — is the current day's `*-GATE` ticket passable? Gates must close before the next
   day's tickets start.
6. **Risks** — open `blocker-risk` tickets, unanswered organiser questions (`D0-02`), and any
   abandoned `feat/*` remote branch.

Keep it to a screenful. End with the single recommended next command.
