---
description: Run one SAAKSHI ticket end to end — branch, PRP, implement, verify, commit, PR, merge, close
argument-hint: <ticket-id | issue-number>   e.g. /start D2-04  or  /start 27
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Skill
---

# /start — execute one ticket, fully

Target: **$ARGUMENTS**

You are running a single ticket of the SAAKSHI project to completion. This command is
**session-independent**: assume you have *no* prior conversation context. Everything you need is in
GitHub and in this repo. Reconstruct it. Never guess, never rely on remembered state, and never
invent a ticket's contents.

Repo: `thopatevijay/saakshi`

## Ground rules — non-negotiable

1. **The GitHub issue is the specification.** Do not add scope, do not remove scope, do not
   "improve" the ticket. If the ticket is wrong, say so and stop — do not silently deviate.
2. **Every Acceptance Criterion must actually be met**, verified by running something, not by
   reading the code and feeling confident.
3. **Every command in the ticket's Validation Gate must be run verbatim and must pass.** If a
   command cannot run, that is a blocker, not a formality to skip.
4. **Never fake a pass.** If an AC cannot be met, go to Phase 8-BLOCKED.
5. Anything you discover that is out of this ticket's scope goes to the **backlog issue** (`BL-01`).
   Do not fix it here.
6. Commits: conventional messages, **no Claude co-author trailer, no "generated with" line**.
   Prefer several small commits over one large one.
7. Never commit `.env`, `.dev-refs.md`, `recon-out/`, model weights, or any secret.
8. **`.env` is off limits.** Never Read/Grep/Glob/Edit/Write it, never `cat`/`head`/`grep` it, and
   never echo a secret value. Load it only as `set -a; . ./.env; set +a`. To check a variable is
   set, print its length — `[ -n "$V" ] && echo "set (${#V})"` — never `${V:-MISSING}`, which
   expands the value. See the STRICT RULE in `CLAUDE.md`.

---

## Phase 0 — Orient (always, no exceptions)

```bash
cd "$(git rev-parse --show-toplevel)"
cat .github/plan/issue-map.json
git status --short && git branch --show-current
gh issue list -R thopatevijay/saakshi --state open --limit 60 \
  --json number,title,labels --jq '.[]|"\(.number)\t\(.title)"'
```

Resolve **$ARGUMENTS** to a ticket id and an issue number using `.github/plan/issue-map.json`
(it maps `D2-04 -> 27`). If the argument is a number, reverse-map it. If it resolves to nothing,
stop and tell the user.

Then read, in this order:
1. `gh issue view <n> -R thopatevijay/saakshi --comments` — **the specification, plus every handoff
   note left by previous tickets**
2. `.github/plan/<TICKET-ID>-*.md` — the versioned source of the ticket
3. `PROJECT.md` — architecture, locked decisions, constraints
4. The `Blocked by:` comment on the issue

## Phase 1 — Blocker check

For every blocker issue: confirm it is **closed**. If any is open:

> Stop. Report which blockers are open. Ask whether to proceed anyway (the user may have a reason)
> or to switch to a blocker instead. Do not start.

## Phase 2 — Branch

```bash
git checkout main && git pull --ff-only origin main 2>/dev/null || git checkout main
git checkout -b feat/<ticket-id-lowercase>-<short-slug>-$(date +%d-%m-%Y)
```

If the branch already exists, check it out and continue from where it left off (a previous session
may have been interrupted — read its commits first with `git log --oneline main..HEAD`).

## Phase 3 — Write the PRP

Write `.prp/<TICKET-ID>.md` (gitignored — local working memory, not a deliverable):

```markdown
# PRP - <TICKET-ID> - <title>
Issue: #<n> · Branch: <branch> · Started: <ISO timestamp>

## Ticket summary
<2-4 lines, in your own words>

## Inherited context
- **Handoffs received:** <from blocker issue comments — quote them>
- **Open blockers:** <none | list>
- **Assumptions I am making:** <explicit, so a future session can challenge them>

## Acceptance Criteria -> plan
| # | AC (verbatim) | How I will satisfy it | How I will PROVE it |
|---|---|---|---|

## Deliverables -> files
| Deliverable | Path |
|---|---|

## Validation Gate commands
<copied verbatim from the ticket>

## Execution steps
1. ...

## Findings for BL-01
<append as you go: bug / gap / pitfall / constraint>

## Handoff to produce on completion
<what downstream tickets need to know — numbers, shapes, contracts>
```

**The AC table must be complete before you write any code.** If you cannot state how you will
*prove* an AC, you do not yet understand it — re-read the ticket.

## Phase 4 — Post the start note

```bash
gh issue edit <n> -R thopatevijay/saakshi --add-label "status:in-progress"
gh issue comment <n> -R thopatevijay/saakshi --body "<start note>"
```

Start note contains: branch name, timestamp, inherited handoffs (or "none"), assumptions, and a
3-6 bullet plan.

## Phase 5 — Implement

Follow the PRP's execution steps. While working:
- Match the surrounding code's conventions. TypeScript strict, no `@ts-ignore`, no `any`.
- Python: type hints, no bare `except`.
- Commit at each meaningful checkpoint: `git commit -m "feat(<scope>): <what> (<TICKET-ID>)"`
- Every discovery outside scope -> append to the PRP's Findings section. Do not chase it.
- If you find the ticket itself is wrong or impossible -> Phase 8-BLOCKED. Do not improvise a
  different ticket.

## Phase 6 — Verification gate (hard stop)

Re-read the issue body. Then, **mechanically**:

1. **Acceptance Criteria** — for each one, state: `AC <n>: PASS — <the evidence>` or
   `AC <n>: FAIL — <why>`. Evidence is command output, a test name, or a file that exists.
   "Looks right" is not evidence.
2. **Deliverables** — confirm each listed path exists and is non-empty.
3. **Validation Gate** — run every command from the ticket verbatim. Paste the real output.
4. **Repo-wide checks** (always, regardless of ticket):
   ```bash
   npm run typecheck && npm run lint && npm run test
   pytest workers -q          # if workers/ was touched
   git status --short         # nothing unexpected, no secrets staged
   git diff --cached --name-only | grep -E '^\.env$|^\.dev-refs\.md$' && echo "SECRET STAGED - STOP"
   ```

**If any AC or gate command fails: do not proceed to Phase 7.** Either fix it, or go to
Phase 8-BLOCKED. There is no partial pass.

## Phase 7 — Land it

```bash
git add -A && git status --short          # review before committing
git commit -m "feat(<scope>): <summary> (<TICKET-ID>)"
git push -u origin <branch>

gh pr create -R thopatevijay/saakshi --base main --head <branch> \
  --title "<TICKET-ID> · <title>" --body "<pr body>"

gh pr merge --squash --delete-branch
git checkout main && git pull --ff-only origin main
```

PR body must contain: `Closes #<n>`, what changed, the AC checklist with evidence per item, the real
validation-gate output, the handoff for downstream tickets, and what was logged to `BL-01`.

Then close out the issue:

```bash
gh issue comment <n> -R thopatevijay/saakshi --body "<done note>"
gh issue edit <n> -R thopatevijay/saakshi \
  --remove-label "status:in-progress" --add-label "status:done"
gh issue close <n> -R thopatevijay/saakshi --reason completed
```

The **done note** is the durable handoff record. It must contain:
- one line per AC with its evidence
- deliverable paths
- gate result
- a `### Handoff -> <downstream ticket ids>` section with the concrete numbers, type shapes and
  endpoint contracts later tickets depend on

**This comment is the handoff mechanism.** A future session with zero context reads it. Be specific:
real measured values, real type shapes, real endpoint contracts — never "see the code".

Then log any findings to the backlog (`/backlog`), and delete `.prp/<TICKET-ID>.md` only after the
handoff comment is posted — the comment is the durable record, the PRP is scratch.

## Phase 8-BLOCKED — when a ticket cannot complete

Never leave a ticket silently half-done. A future session must be able to pick it up cold.

```bash
git add -A && git commit -m "wip(<scope>): <what got done> (<TICKET-ID>)" && git push -u origin <branch>
gh issue edit <n> -R thopatevijay/saakshi \
  --remove-label "status:in-progress" --add-label "status:blocked"
gh issue comment <n> -R thopatevijay/saakshi --body "<blocked note>"
```

Blocked note must contain: what is done (with commits), what is not (the failing ACs verbatim), why
(root cause with the actual error output), what was tried, what would unblock it (specific — a
decision, a helpdesk answer, hardware, an upstream ticket), and the exact next step for a session
with no context.

Then report to the user: what is blocked, why, and the options. Log it to `BL-01`.

## Report back to the user

Close with a short summary: ticket, what shipped, AC pass count, gate result, PR link, handoff
posted, findings logged, and which `/start` to run next (per milestone order and blockers).
