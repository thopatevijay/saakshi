# SAAKSHI workflow — session-independent by design

Any Claude Code session, on any machine, at any hour, can pick up this project with **zero prior
context** and keep building. Nothing important lives in a conversation.

## Where state lives

| State | Home | Why there |
|---|---|---|
| Ticket specs (AC, deliverables, gates) | `.github/plan/*.md`, committed | Versioned, reviewable, diffable |
| Ticket ↔ issue number map | `.github/plan/issue-map.json`, committed | Lets any session resolve `D2-04` → `#27` |
| Live status | GitHub issue labels: `status:in-progress` / `status:blocked` / `status:done` | Queryable without context |
| **Handoffs between tickets** | **GitHub issue comments** | The durable record. Read before starting any ticket. |
| Findings, gaps, limitations | `BL-01` issue comments | Triaged into deck + roadmap by `D4-08` |
| Architecture & locked decisions | `PROJECT.md`, committed | Single source of truth |
| Per-ticket scratch plan | `.prp/<TICKET-ID>.md`, **gitignored** | Working memory only; deleted after handoff is posted |
| Endpoints, credentials locations | `.dev-refs.md`, **gitignored** | Never committed |

**The rule:** if a fact matters to a later ticket, it goes in an **issue comment**, not only in a
gitignored file and never only in a chat.

**The corollary, which is easy to miss:** a fact that matters to *one specific* later ticket goes in
a comment on **that ticket**, not only on the closing ticket and `BL-01`. A session running
`/start D3-06` cold reads **its own** issue's comments — it has no reason to open a closed ticket's
handoff. A warning filed only upstream is a warning that will never be read, which makes the handoff
system *look* like it works while quietly failing.

## One-time setup

```bash
gh auth login -h github.com -s repo,project        # interactive
cd ~/hackathons/saakshi
python3 scripts/bootstrap_github.py --repo thopatevijay/saakshi --dry-run   # preview
python3 scripts/bootstrap_github.py --repo thopatevijay/saakshi             # create
git add -A && git commit -m "chore: project plan, workflow and scaffold" && git push -u origin main
```

`bootstrap_github.py` is **idempotent**. Edit a ticket in `.github/plan/`, re-run it, and the issue
body syncs. The plan in git and the plan on GitHub never drift.

## The five commands

| Command | What it does |
|---|---|
| `/start <TICKET-ID>` | Branch → read issue + inherited handoffs → write PRP → implement → verify every AC → run the validation gate → commit → push → PR → squash-merge → close with a handoff comment |
| `/start-wave <MILESTONE>` | A whole milestone in dependency-ordered waves: parallel workers in isolated worktrees and databases, merged and gated by a manager |
| `/gate <GATE-ID>` | Verify a whole day from a **clean state** before the next day begins |
| `/backlog "<finding>"` | Log a bug/gap/pitfall/constraint to `BL-01` without derailing the ticket in flight |
| `/status` | Rebuild the full picture from GitHub + git and name the single next command |

Both `/start D2-04` and `/start 27` work.

### When to use `/start-wave` instead of `/start`

Run `python3 scripts/waves.py <MILESTONE>` first — it is free and read-only. It computes the
dependency waves, pre-allocates a migration number per ticket, assigns each worker its own database,
and flags the tickets that need the live sandbox.

**Parallelism only pays where the graph is wide.** Measured across this plan:

| Milestone | Tickets | Waves | Widest wave | Use |
|---|---|---|---|---|
| `D1` | 9 | 6 | 3 | `/start` — nearly a chain |
| `D2` | 8 | 5 | 3 | `/start` — ANPR → normalise → fuzzy → alerts → queue is sequential |
| `D3` | 11 | **2** | **8** | **`/start-wave`** — the big win |
| `D4` | 8 | **2** | **6** | **`/start-wave`** |

A milestone whose waves are mostly width 1–2 gains nothing: the coordination overhead exceeds the
saving. The planner prints the shape; believe it rather than the ticket count.

### It refuses to start on unsafe ground

`/start-wave` pre-flights before spawning anything, and **stops** if a ticket is already
`status:in-progress` or `status:blocked`, if a `.prp/` file or a `feat/<ticket>-*` branch already
exists for a ticket it is about to spawn, if the tree is dirty, or if a blocker outside the
milestone is still open. The planner prints `Safe to spawn: YES/NO`.

This is stricter than `/start` on purpose: a sequential ticket that hits a surprise costs one
ticket, while a wave that hits one costs three workers, three worktrees, three databases and a merge
sequence to unpick.

It then reads the closed blockers' handoffs **as the manager** — not for implementation detail,
which the workers read themselves, but for the facts that change the *schedule*: shared-resource
limits ("the gateway throttles ~10×", "a full sweep is 23.6 minutes"), contention between tickets
that have no dependency edge, and timing warnings.

### Three limits that are not negotiable

- **Three concurrent workers, maximum.** Past three, the shared Postgres and the sandbox gateway
  dominate. The gateway degrades roughly tenfold under sustained load — **4.2 s → 63 s** measured on
  the same 1.3 KB fetch — and every concurrent measurement then describes our own load rather than
  the estate. On a build where the measurements *are* the product, that is not a speed/quality
  trade; it is just damage.
- **One live-feed ticket at a time**, regardless of the concurrency cap.
- **Never overlap waves.** Wave N+1 reads wave N's handoff comments. Starting early throws away the
  mechanism that makes this workflow produce good work — a worker with no handoff to read
  rediscovers the same traps, or doesn't.

## The loop

```
/status                    →  what is next
/start <TICKET-ID>         →  ticket lands, handoff posted on the issue
   ...repeat through the day...
/gate D1-GATE              →  day verified from clean state, next day unlocked
```

Findings go to `/backlog` as you hit them. `D4-08` turns them into the deck's
*"What this system does not do"* slide and the *Future Roadmap* dimension — both scored.

## Hard rules the commands enforce

- The GitHub issue is the specification. No scope added, no scope dropped, no silent deviation.
- An AC passes only with **evidence** — command output, a test name, a file, a row count. Never
  "looks right".
- Every Validation Gate command runs **verbatim**. A command that cannot run is a blocker, not a
  formality.
- A ticket that cannot finish goes to `Phase 8-BLOCKED`: WIP pushed, `status:blocked`, and a comment
  stating what is done, what is not, why, what was tried, what would unblock it, and the exact next
  step for a session with no context. **Never silently half-done.**
- Gates are empirical and run from a clean state. Bonus tickets (`D3-03`, `D3-09`, `D3-10`) may be
  closed as *deferred* with a roadmap entry; non-bonus ACs may not.
- Commits: conventional messages, no Claude co-author or "generated with" trailer, small and frequent.
- Never commit `.env`, `.dev-refs.md`, `recon-out/`, model weights, or any secret.
- A **stale** gate command — one describing a system that has since changed — is still run verbatim
  and its real output recorded. Satisfy the underlying checkbox by other means, say so plainly, and
  log it. **Change the evidence, never the standard.** Never widen an interval, add a flag, or weaken
  auth to make a literal command pass.
- A finding that breaks a later ticket gets a comment on **that** ticket as well as on `BL-01`.

## Resuming cold — what a fresh session does

1. `/status`
2. Interrupted work first: a `.prp/` file for a ticket **not** labelled in-flight, or a remote
   `feat/*` branch with no open PR. Either means a session died mid-ticket —
   `git checkout <branch>` then `/start <TICKET-ID>`, which resumes an existing branch rather than
   restarting it. Never open a new ticket while one is half-landed.
3. Otherwise `/start` the lowest-numbered open ticket whose blockers are all closed.
4. Before writing code, read the blockers' **handoff comments**. They carry the measured numbers,
   type shapes and endpoint contracts the ticket depends on.

## Plan shape

44 tickets · 5 milestones · 4 gates + 1 submission gate.

| Milestone | Due | Tickets |
|---|---|---|
| Day 0 — Recon & Bootstrap | 3 Sep | `D0-01` `D0-02` `D0-03` |
| Day 1 — Registry & Ingest Foundation | 4 Sep | `D1-01`…`D1-09`, `D1-GATE` |
| Day 2 — Analytics & Alert Core | 5 Sep | `D2-01`…`D2-08`, `D2-GATE` |
| Day 3 — Differentiators | 6 Sep | `D3-01`…`D3-11`, `D3-GATE` |
| Day 4 — Deploy & Submit | 7 Sep | `D4-01`…`D4-08`, `D4-SUBMIT` |
| Running | — | `BL-01` (backlog) |

**`D0-01` first, and nothing else until it closes.** It is the only ticket that can invalidate the
architecture: if the sandbox feeds have unreadable plates, the weighting shifts to Pillars 1/2/4
before a line of feature code is written.
