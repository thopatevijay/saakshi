---
description: Run a whole SAAKSHI milestone in dependency-ordered waves — parallel workers in isolated worktrees, merged and gated by a manager
argument-hint: <milestone-id>   e.g. /start-wave D3
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Skill, TaskOutput, TaskStop
---

# /start-wave — a milestone, in parallel, without losing the things that make `/start` work

Milestone: **$ARGUMENTS**

You are the **manager**. You do not implement tickets. You plan the waves, spawn one worker per
ticket, keep the shared resources from colliding, merge in order, and gate the result.

## Read this before spawning anything

`/start` is sequential for reasons that are not accidental, and three of them survive parallelism
only if you actively protect them:

1. **Handoffs are a sequencing artifact.** A ticket's quality comes from reading its blockers'
   *completed* handoff comments. D1-05 caught a bug in one glance because D1-03's handoff named it.
   Tickets in the **same wave have no handoff from each other** — that is exactly why they are in the
   same wave. Tickets in a **later wave do**, which is why waves are merged before the next starts.
   **Never overlap waves.**
2. **A worktree isolates files. It does not isolate Postgres or the sandbox gateway.** Each worker
   gets its own database. The gateway gets a semaphore of one.
3. **The GitHub issue is still the specification.** Every worker runs the full `/start` contract —
   AC by AC, gate verbatim, evidence not vibes. Parallelism changes the schedule, never the standard.

## Step 1 — Plan

```bash
cd "$(git rev-parse --show-toplevel)"
git checkout main && git pull --ff-only origin main
python3 scripts/waves.py $ARGUMENTS
```

The planner outputs, per ticket: its issue number, its **pre-allocated migration prefix**, its
**own database name**, its branch, and whether it needs the **live feed**.

**Stop and report if `BLOCKED BY TICKETS OUTSIDE THIS MILESTONE` is non-empty.** Those blockers are
in an earlier milestone and are not this command's job. Name them and stop — a wave built on an open
blocker produces workers that cannot verify their own ACs.

Show the user the plan and the honest expectation before spawning:

- **wave count and width** — a 5-wave milestone with max width 3 is nearly sequential, and
  parallelism will buy close to nothing. Say so rather than spawning anyway.
- **rough wall-clock**: `sum over waves of (ceil(wave_size / 3) x longest estimate in that wave)`,
  plus a merge-and-gate pass per wave.

## Step 2 — Prepare the shared resources

Per ticket in the wave about to run:

```bash
set -a; . ./.env; set +a
ADMIN="postgres://saakshi:saakshi@localhost:5432/postgres"

# One database per worker. Verified: 12 migrations apply cleanly to a fresh one in well under a
# minute, and it removes an entire class of flaky gate failures — D1-04's suite once marked all 30
# live cameras absent because it shared a database with another run.
#
# `psql "<url>" -c 'create database …'`, NOT bare `createdb`: createdb has no password in its
# argument list, prompts interactively, and a spawned worker hangs on the prompt forever.
psql "$ADMIN" -c "create database <worker_db>" 2>&1 | tail -1
DATABASE_URL="postgres://saakshi:saakshi@localhost:5432/<worker_db>" npm run db:migrate
```

Tear them down after the milestone: `psql "$ADMIN" -c "drop database <worker_db>"`.

Seed it the same way the ticket's gate expects. If the ticket needs the estate, run
`sync:catalogue` against **that** database — **not** in parallel across workers, because the
catalogue fetch shares the throttled gateway.

## Step 3 — Spawn the wave

**At most three workers at once.** Not a guess: past three, the shared Postgres and the sandbox
gateway dominate, and the gateway degrades ~10x under sustained load — measured **4.2 s → 63 s** for
the same 1.3 KB fetch. Every concurrent measurement then describes our own load rather than the
estate, which silently corrupts exactly the tickets that measure things.

If a wave is wider than three, run it in batches of three. Merge each batch before the next.

**The live-feed semaphore is 1.** Tickets flagged `[LIVE FEED]` touch the sandbox. Never run two of
them concurrently, even inside a batch of three — pair one live-feed ticket with two that are not.

Spawn each worker with the Agent tool and `isolation: "worktree"`.

**The worker runs the real `/start` contract, not a paraphrase of it.** Its first instruction is to
invoke the `start` skill for its ticket, which loads `.claude/commands/start.md` verbatim — the same
254-line contract every sequential ticket has followed. Nothing about the standard changes because
the work is parallel.

Give each worker exactly this, filled in from the planner's output:

> Invoke the `start` skill with `<TICKET-ID>` and follow it. **Phases 0 through 6 apply exactly as
> written** — orient, blocker check, branch, PRP, post the start note, implement, and the full
> Phase 6 verification gate. Then these overrides apply:
>
> **Phase 7 is REPLACED. Do not merge. Do not close the issue. Do not change labels to `status:done`.**
> Stop after: `git add -A` → commit → `git push -u origin <branch>` → `gh pr create`. The PR body
> must still carry everything Phase 7 requires, **including the full handoff section** — the manager
> posts it to the issue after merging, so a handoff missing from your PR body is a handoff lost.
> Report the PR number in your final summary.
>
> **Merging is the manager's, in wave order.** Your migration number was allocated on the assumption
> that PRs land in the planner's sequence; a self-merge breaks that sequence for every other worker.
>
> - **Migration prefix:** if you create a migration it MUST be `<NNNN>_*.sql`. Never take the next
>   number you see on disk — another worker owns it right now.
> - **Database:** `DATABASE_URL=<worker_db_url>`. Use only this. Never the default; another worker's
>   gate is running against it.
> - **Live feed:** `<held | not held>`. If you do not hold it, do not touch the sandbox gateway —
>   no `sync:catalogue`, no prober sweep, no adapter probe against `SENTINEL_HOST`.
> - **Read your own issue's comments before writing code.** Earlier tickets have posted blocker
>   notes there; they carry the constraint that would otherwise cost you a rewrite.
> - Then the hot-file rule below.
>
> If you cannot finish, use `/start`'s **Phase 8-BLOCKED** unchanged — push WIP, label
> `status:blocked`, post the blocked note. Report that you are blocked; do not report success.

**Why Phase 7 is the only thing overridden.** Everything before it is what makes a ticket correct —
reading the inherited handoffs, proving each AC with evidence, running the gate verbatim. Only the
*landing* is a shared-resource operation, and shared resources are the manager's job.

### The hot-file rule, given to every worker

Measured across the six merged D1 tickets: `package.json` changed in **6 of 6**,
`packages/api/src/server.ts` in 4, `packages/shared/src/db/schema.ts` in 3. Three branches editing
those simultaneously is three conflicts.

> Keep edits to `package.json`, `server.ts`, `schema.ts`, `shared/src/index.ts`, `vitest.config.ts`
> and `eslint.config.mjs` **as small as you can** — one script line, one `register*Routes` call, one
> table. Put everything else in files only your ticket owns. Report in your final summary **exactly
> which hot files you touched and what you added**, so the manager can resolve a conflict without
> re-reading your branch.

## Step 4 — Merge the wave, in order

Workers finish out of order. **Merge in the planner's order**, not in finish order — the migration
numbers were allocated in that sequence, and merging out of order leaves a gap that
`npm run db:migrate` will refuse on a clean database.

For each PR, in order:

```bash
gh pr checks <n> -R thopatevijay/saakshi 2>/dev/null || true
gh pr merge <n> -R thopatevijay/saakshi --squash --delete-branch
git checkout main && git pull --ff-only origin main
```

**Conflict on a hot file:** resolve it yourself from the worker's reported summary — these are
additive by construction (a script, a route registration, a table). Do not send it back to the
worker; its worktree is already merged-behind and it would resolve against a stale base.

**After the whole wave is merged, run the repo-wide gate once** — not once per worker:

```bash
npm run typecheck && npm run lint && npm run format:check
npm run test
pytest workers -q
npm run db:reset && npm run db:migrate    # migrations apply cleanly, in sequence, from scratch
```

A failure here belongs to the manager. Fix it on `main`, or revert the offending merge and re-open
its ticket with `status:blocked` and the real error. **Never start the next wave on a red main.**

## Step 5 — Close out the wave

Workers deliberately do **not** close their own issues, so this is yours. For each merged ticket, in
the same order:

```bash
gh issue comment <n> -R thopatevijay/saakshi --body "<handoff, taken from the PR body>"
gh issue edit <n> -R thopatevijay/saakshi --remove-label "status:in-progress" --add-label "status:done"
gh issue close <n> -R thopatevijay/saakshi --reason completed
```

**The handoff comment is not paperwork — it is what the next wave reads.** A ticket closed without
one silently degrades every ticket that depends on it, and the degradation shows up as a bug someone
rediscovers rather than as a missing file. If a worker's PR body has no handoff section, reconstruct
it from the diff and its final report before closing.

Then post any cross-ticket blocker notes the workers surfaced — `/backlog`'s rule applies unchanged:
a finding that breaks a later ticket gets a comment on **that** ticket, not only on `BL-01`.

Verify the wave is genuinely closed out:

```bash
for n in <issue numbers>; do
  gh issue view $n -R thopatevijay/saakshi --json number,state,labels,comments \
    --jq '"#\(.number) \(.state) \([.labels[].name]|join(",")) comments=\(.comments|length)"'
done
```

Then report the wave to the user — merged, blocked, gate result — and start the next wave.

## Step 6 — Finish the milestone

When the last wave is merged and green, tell the user the milestone is ready and name the gate
command (`/gate <MILESTONE>-GATE`). **Do not run the gate yourself** — it is a hard stop that must
be run from a clean state, and it is the user's decision when to spend that time.

## Do not

- **Do not overlap waves.** Wave N+1's tickets read wave N's handoffs; starting early throws away
  the mechanism that makes this workflow produce good work.
- **Do not exceed three concurrent workers, or two live-feed tickets at once.** The limits exist
  because the measurements are the product.
- **Do not let a worker merge its own PR.** Out-of-order merges break the migration sequence.
- **Do not use this on a nearly-sequential milestone.** If the planner shows max width 1–2 across
  most waves, say so and recommend plain `/start` — the coordination overhead exceeds the gain.
- **Do not relax an AC or a gate because a worker is slow.** Parallelism changes the schedule, never
  the standard. A worker that cannot finish goes to Phase 8-BLOCKED exactly as in `/start`.
