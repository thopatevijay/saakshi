#!/usr/bin/env python3
"""Compute the parallel execution plan for a SAAKSHI milestone.

`/start-wave` needs three things decided *before* any worker starts, deterministically:

  1. **Which tickets can run at once.** Derived from `blocked_by`, as topological levels
     ("waves"). Tickets in the same wave share no dependency and may run in parallel.
  2. **Which migration number each ticket owns.** Sequentially numbered migrations are the
     single worst conflict class in this repo — two parallel tickets both writing `0013_*.sql`
     collide at merge with no automatic resolution. The manager allocates them up front.
  3. **Which tickets contend for a shared resource.** One Postgres and one throttled sandbox
     gateway are not isolated by a git worktree. The gateway in particular degrades ~10x under
     sustained load (measured: 4.2s -> 63s for the same 1.3 KB fetch), which corrupts every
     concurrent measurement, so live-feed tickets must take turns.

Running it is free and read-only:

    python3 scripts/waves.py D3               # human-readable plan
    python3 scripts/waves.py D3 --json        # machine-readable, for the command to consume
    python3 scripts/waves.py D3 --offline     # skip GitHub; treat nothing as closed
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLAN_DIR = ROOT / ".github" / "plan"
ISSUE_MAP = PLAN_DIR / "issue-map.json"
MIGRATIONS = ROOT / "db" / "migrations"
REPO = "thopatevijay/saakshi"

#: Concurrency ceiling. Not a guess: past three workers the shared Postgres and the sandbox
#: gateway dominate, and the measurements every CV ticket depends on stop being trustworthy.
#: Raising this trades correctness for wall-clock, which is the wrong trade on a graded build.
MAX_CONCURRENCY = 3

#: Tickets that read the live sandbox. Only ONE of these may run at a time regardless of the
#: concurrency cap — see the module docstring on gateway throttling.
LIVE_FEED_KEYWORDS = ("hls", "sandbox", "whep", "own-feed", "video wall", "re-id", "demonstration")

#: Files that nearly every ticket edits. Measured across the six merged D1 tickets:
#: package.json 6/6, server.ts 4/6, schema.ts 3/6. Workers are told to keep edits here minimal
#: and the manager resolves them at merge time rather than letting three branches diverge.
HOT_FILES = (
    "package.json",
    "packages/api/src/server.ts",
    "packages/shared/src/db/schema.ts",
    "packages/shared/src/index.ts",
    "vitest.config.ts",
    "eslint.config.mjs",
)


def ticket_id(path: pathlib.Path) -> str:
    return "-".join(path.name.split("-")[:2])


def load_plan() -> dict[str, dict]:
    """Every ticket's id, title, blockers and whether it needs the live feed."""
    plan: dict[str, dict] = {}
    for path in sorted(PLAN_DIR.glob("D*.md")):
        text = path.read_text()
        blocked = re.search(r"^blocked_by:\s*\[(.*?)\]", text, re.M)
        title = re.search(r'^title:\s*"(.*?)"', text, re.M)
        estimate = re.search(r'^estimate:\s*"(.*?)"', text, re.M)
        lowered = text.lower()
        plan[ticket_id(path)] = {
            "id": ticket_id(path),
            "title": title.group(1) if title else path.stem,
            "blocked_by": re.findall(r'"([^"]+)"', blocked.group(1)) if blocked else [],
            "needs_live_feed": any(k in lowered for k in LIVE_FEED_KEYWORDS),
            "estimate": estimate.group(1) if estimate else "?",
            "file": str(path.relative_to(ROOT)),
        }
    return plan


def github_state(issue_map: dict[str, int], offline: bool) -> dict[str, set[str]]:
    """Ticket ids that are closed, in flight, or blocked.

    `closed` decides the waves. The other two decide whether it is safe to spawn at all: a ticket
    already labelled `status:in-progress` has a session or a worktree working on it right now, and
    spawning a second worker onto it produces two branches racing to land the same ticket.
    """
    empty = {"closed": set(), "in_progress": set(), "blocked": set()}
    if offline:
        return empty

    by_number = {num: tid for tid, num in issue_map.items()}
    try:
        raw = subprocess.run(
            ["gh", "issue", "list", "-R", REPO, "--state", "all", "--limit", "100",
             "--json", "number,state,labels"],
            capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        print(f"warning: could not reach GitHub ({exc}); treating all tickets as open",
              file=sys.stderr)
        return empty

    state = {"closed": set(), "in_progress": set(), "blocked": set()}
    for row in json.loads(raw):
        tid = by_number.get(row["number"])
        if tid is None:
            continue
        labels = {label["name"] for label in row["labels"]}
        if row["state"] == "CLOSED":
            state["closed"].add(tid)
        elif "status:in-progress" in labels:
            state["in_progress"].add(tid)
        elif "status:blocked" in labels:
            state["blocked"].add(tid)
    return state


def local_hazards(pending: set[str]) -> dict[str, list[str]]:
    """Local state that would collide with a fresh worker.

    Scoped to the tickets about to be spawned — a leftover branch for an already-merged ticket is
    housekeeping, not a hazard, and reporting it buries the one that matters.

    An orphaned `.prp/` file or an existing `feat/<ticket>-*` branch both mean a previous attempt at
    *this* ticket exists. Spawning over either loses that work or races it to `main`.
    """
    hazards: dict[str, list[str]] = {}

    prps = {f.stem for f in (ROOT / ".prp").glob("*.md")} if (ROOT / ".prp").is_dir() else set()
    for tid in sorted(pending & prps):
        hazards.setdefault(tid, []).append(".prp/%s.md exists — interrupted work" % tid)

    try:
        branches = subprocess.run(
            ["git", "branch", "-a", "--format=%(refname:short)"],
            capture_output=True, text=True, check=True, cwd=ROOT,
        ).stdout.split()
    except (subprocess.CalledProcessError, FileNotFoundError):
        branches = []
    for tid in sorted(pending):
        stub = f"feat/{tid.lower()}-"
        existing = [b for b in branches if stub in b]
        if existing:
            hazards.setdefault(tid, []).append(
                "branch already exists: %s" % ", ".join(sorted(set(existing))[:3]))

    try:
        dirty = subprocess.run(["git", "status", "--porcelain"],
                               capture_output=True, text=True, check=True, cwd=ROOT).stdout.strip()
        branch = subprocess.run(["git", "branch", "--show-current"],
                                capture_output=True, text=True, check=True, cwd=ROOT).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        dirty, branch = "", ""
    if dirty:
        hazards.setdefault("(repo)", []).append(
            "working tree is dirty — %d path(s) uncommitted" % len(dirty.splitlines()))
    if branch and branch != "main":
        hazards.setdefault("(repo)", []).append(f"not on main (on {branch})")

    return hazards


def next_migration_number() -> int:
    numbers = [int(p.name[:4]) for p in MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.up.sql")]
    return (max(numbers) + 1) if numbers else 1


def compute_waves(tickets: dict[str, dict], done: set[str]) -> list[list[str]]:
    """Topological levels over intra-milestone dependencies.

    A blocker outside this milestone, or one already closed, does not create a wave here — it is
    either satisfied or somebody else's problem. A blocker inside the milestone that is still open
    is what forces a later wave.
    """
    scope = set(tickets)
    level: dict[str, int] = {}

    def depth(tid: str, seen: tuple[str, ...] = ()) -> int:
        if tid in level:
            return level[tid]
        if tid in seen:  # a cycle in the plan; report it rather than recursing forever
            raise SystemExit(f"dependency cycle involving {tid}: {' -> '.join(seen)}")
        deps = [d for d in tickets[tid]["blocked_by"] if d in scope and d not in done]
        level[tid] = 0 if not deps else 1 + max(depth(d, seen + (tid,)) for d in deps)
        return level[tid]

    for tid in tickets:
        depth(tid)

    grouped: dict[int, list[str]] = defaultdict(list)
    for tid, lvl in level.items():
        grouped[lvl].append(tid)
    return [sorted(grouped[lvl]) for lvl in sorted(grouped)]


def external_blockers(tickets: dict[str, dict], done: set[str], scope: set[str]) -> dict[str, list[str]]:
    """Blockers outside the milestone that are still open — these stop the wave plan dead."""
    out = {}
    for tid, t in tickets.items():
        open_external = [d for d in t["blocked_by"] if d not in scope and d not in done]
        if open_external:
            out[tid] = open_external
    return out


def build(milestone: str, offline: bool) -> dict:
    plan = load_plan()
    issue_map = json.loads(ISSUE_MAP.read_text())
    state = github_state(issue_map, offline)
    done = state["closed"]

    scope = {
        tid: t for tid, t in plan.items()
        if tid.startswith(f"{milestone}-") and "GATE" not in tid and "SUBMIT" not in tid
    }
    if not scope:
        raise SystemExit(f"no tickets found for milestone {milestone}")

    remaining = {tid: t for tid, t in scope.items() if tid not in done}
    waves = compute_waves(remaining, done) if remaining else []
    blocked_outside = external_blockers(remaining, done, set(scope))
    hazards = local_hazards(set(remaining))

    # Migration numbers are allocated in wave-then-alphabetical order, so the sequence on main
    # after merging matches the order the manager merges in.
    next_num = next_migration_number()
    allocation: dict[str, str] = {}
    for wave in waves:
        for tid in wave:
            allocation[tid] = f"{next_num:04d}"
            next_num += 1

    return {
        "milestone": milestone,
        "max_concurrency": MAX_CONCURRENCY,
        "total": len(scope),
        "already_done": sorted(done & set(scope)),
        "waves": [
            [
                {
                    "id": tid,
                    "issue": issue_map.get(tid),
                    "title": remaining[tid]["title"],
                    "estimate": remaining[tid]["estimate"],
                    "migration_prefix": allocation[tid],
                    "needs_live_feed": remaining[tid]["needs_live_feed"],
                    "worker_db": f"saakshi_{tid.lower().replace('-', '_')}",
                    "branch": f"feat/{tid.lower()}-wave",
                }
                for tid in wave
            ]
            for wave in waves
        ],
        "blocked_by_external": blocked_outside,
        # Safety, not scheduling: these do not change the waves, they decide whether spawning is
        # safe at all. The command refuses to start while any of them is non-empty.
        "in_progress": sorted(state["in_progress"] & set(scope)),
        "already_blocked": sorted(state["blocked"] & set(scope)),
        "local_hazards": hazards,
        "safe_to_spawn": not (state["in_progress"] & set(scope))
                         and not (state["blocked"] & set(scope))
                         and not hazards
                         and not blocked_outside,
        "hot_files": list(HOT_FILES),
    }


def render(plan: dict) -> str:
    lines: list[str] = []
    add = lines.append
    add("")
    add(f"  Milestone {plan['milestone']} — {plan['total']} tickets, "
        f"{len(plan['already_done'])} already done, {len(plan['waves'])} wave(s)")
    add(f"  Concurrency cap {plan['max_concurrency']} · live-feed semaphore 1")
    add(f"  Safe to spawn: {'YES' if plan['safe_to_spawn'] else 'NO — see pre-flight below'}")
    add("")

    problems = (plan["in_progress"] or plan["already_blocked"]
                or plan["local_hazards"] or plan["blocked_by_external"])
    if problems:
        add("  ✋ PRE-FLIGHT — resolve before spawning anything:")
        for tid in plan["in_progress"]:
            add(f"      {tid}  is labelled status:in-progress — a session is already on it")
        for tid in plan["already_blocked"]:
            add(f"      {tid}  is labelled status:blocked — read its blocked note first")
        for tid, notes in sorted(plan["local_hazards"].items()):
            for note in notes:
                add(f"      {tid}  {note}")
        add("")

    if plan["blocked_by_external"]:
        add("  ⚠ BLOCKED BY TICKETS OUTSIDE THIS MILESTONE — resolve before starting:")
        for tid, deps in sorted(plan["blocked_by_external"].items()):
            add(f"      {tid}  needs  {', '.join(deps)}")
        add("")

    for index, wave in enumerate(plan["waves"]):
        live = sum(1 for t in wave if t["needs_live_feed"])
        note = f"  ({live} need the live feed — they take turns)" if live > 1 else ""
        add(f"  ── wave {index}: {len(wave)} ticket(s){note}")
        for t in wave:
            flag = " [LIVE FEED]" if t["needs_live_feed"] else ""
            add(f"      {t['id']}  #{t['issue']:<3}  migration {t['migration_prefix']}  "
                f"db {t['worker_db']}{flag}")
            add(f"              {t['title']}")
        add("")

    if plan["already_done"]:
        add(f"  done already: {' '.join(plan['already_done'])}")
        add("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("milestone", help="e.g. D3")
    parser.add_argument("--json", action="store_true", help="emit the plan as JSON")
    parser.add_argument("--offline", action="store_true", help="do not query GitHub")
    args = parser.parse_args()

    plan = build(args.milestone.upper(), args.offline)
    print(json.dumps(plan, indent=2) if args.json else render(plan))
    return 0


if __name__ == "__main__":
    sys.exit(main())
