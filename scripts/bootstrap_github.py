#!/usr/bin/env python3
"""
Create/sync GitHub labels, milestones and issues from .github/plan/*.md — idempotent.

Every ticket is a versioned markdown file with frontmatter. This script is the ONLY way issues get
created, so the plan in git and the plan on GitHub never drift. Safe to re-run: existing issues are
updated in place, never duplicated.

Writes .github/plan/issue-map.json (COMMITTED) mapping ticket-id -> issue number. That file is how
any future Claude session resolves "D2-04" to an issue number without prior context.

Usage:
    python3 scripts/bootstrap_github.py --repo thopatevijay/saakshi [--dry-run]
"""
from __future__ import annotations

import argparse, json, re, subprocess, sys
from pathlib import Path

PLAN = Path(".github/plan")
MAP = PLAN / "issue-map.json"

MILESTONES = [
    ("Day 0 — Recon & Bootstrap",            "2026-09-03", "Feed reconnaissance, organiser questions, repo bootstrap. No feature code."),
    ("Day 1 — Registry & Ingest Foundation", "2026-09-04", "Model 1 registry + GIS, adapter framework, trust prober, vertical slice."),
    ("Day 2 — Analytics & Alert Core",       "2026-09-05", "ANPR, fuzzy plate matching, watchlist, alert engine, vehicle trace. The graded loop."),
    ("Day 3 — Differentiators",              "2026-09-06", "Route reconstruction, cloning detection, audit chain, retention clock, gap analysis, sizing."),
    ("Day 4 — Deploy & Submit",              "2026-09-07", "Railway deploy, judge access, demos, deck, HLD, submit by midday."),
]

LABELS = {
    "day-0": "0e8a16", "day-1": "1d76db", "day-2": "5319e7", "day-3": "b60205", "day-4": "d93f0b",
    "gate": "000000", "backlog": "fbca04", "meta": "cfd3d7",
    "backend": "0052cc", "frontend": "006b75", "cv": "5319e7", "infra": "444444",
    "data": "1d76db", "docs": "c2e0c6", "deploy": "d4c5f9", "security": "b60205",
    "pillar-1": "c5def5", "pillar-2": "c5def5", "pillar-3": "c5def5", "pillar-4": "c5def5",
    "differentiator": "ff9f1c", "critical": "b60205", "headline": "ff9f1c",
    "mandatory-requirement": "b60205", "mandatory-deliverable": "b60205",
    "model-1-deliverable": "0e8a16", "model-3-core": "0e8a16",
    "scored-dimension": "fbca04", "test-case": "d93f0b", "compliance": "5319e7",
    "bonus": "bfdadc", "stretch": "bfdadc", "recon": "0e8a16",
    "blocker-risk": "e11d21", "high-value": "ff9f1c", "submission": "d93f0b",
    "ai": "5319e7", "perf": "fef2c0", "status:in-progress": "fbca04",
    "status:blocked": "e11d21", "status:done": "0e8a16",
}


def sh(args: list[str], check=True) -> str:
    r = subprocess.run(args, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f"FAILED: {' '.join(args)}\n{r.stderr.strip()}")
    return r.stdout.strip()


def parse(path: Path) -> dict:
    """Minimal frontmatter parser — title/milestone/estimate as scalars, labels/blocked_by as lists."""
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        raise SystemExit(f"{path}: missing frontmatter")
    fm, body = m.group(1), m.group(2).strip()
    meta: dict = {}
    for line in fm.splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        k, _, v = line.partition(":")
        k, v = k.strip(), v.strip()
        if v.startswith("["):
            meta[k] = [x.strip().strip('"\'') for x in v[1:-1].split(",") if x.strip()]
        else:
            meta[k] = v.strip('"\'')
    meta["body"] = body
    tid = re.match(r"^([A-Z0-9]+-[A-Z0-9]+)", path.name)
    if not tid:
        raise SystemExit(f"{path}: filename must start with a ticket id like D2-04- or BL-01-")
    meta["ticket_id"] = tid.group(1)
    meta["file"] = str(path)
    for req in ("title", "milestone"):
        if req not in meta:
            raise SystemExit(f"{path}: frontmatter missing '{req}'")
    return meta


def ensure_labels(repo: str, dry: bool) -> None:
    existing = {l["name"] for l in json.loads(
        sh(["gh", "label", "list", "-R", repo, "--limit", "200", "--json", "name"]) or "[]")}
    for name, colour in LABELS.items():
        if name in existing:
            continue
        print(f"  + label {name}")
        if not dry:
            sh(["gh", "label", "create", name, "-R", repo, "--color", colour, "--force"])


def ensure_milestones(repo: str, dry: bool) -> dict[str, int]:
    out = sh(["gh", "api", f"repos/{repo}/milestones?state=all&per_page=100"])
    have = {m["title"]: m["number"] for m in json.loads(out or "[]")}
    for title, due, desc in MILESTONES:
        if title in have:
            continue
        print(f"  + milestone {title}")
        if dry:
            have[title] = -1
            continue
        res = sh(["gh", "api", f"repos/{repo}/milestones", "-X", "POST",
                  "-f", f"title={title}", "-f", f"description={desc}",
                  "-f", f"due_on={due}T23:59:59Z"])
        have[title] = json.loads(res)["number"]
    return have


def existing_issues(repo: str) -> dict[str, dict]:
    out = sh(["gh", "issue", "list", "-R", repo, "--state", "all", "--limit", "300",
              "--json", "number,title,state"])
    return {i["title"]: i for i in json.loads(out or "[]")}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    dry = args.dry_run

    if not PLAN.is_dir():
        raise SystemExit("run from the repo root (.github/plan not found)")

    tickets = [parse(p) for p in sorted(PLAN.glob("*.md"))]
    order = {"BL": 0, "D0": 1, "D1": 2, "D2": 3, "D3": 4, "D4": 5}
    tickets.sort(key=lambda t: (order.get(t["ticket_id"][:2], 9), t["ticket_id"]))
    print(f"{len(tickets)} tickets in {PLAN}\n")

    print("labels:");     ensure_labels(args.repo, dry)
    print("milestones:"); ms = ensure_milestones(args.repo, dry)
    print("issues:")

    have = existing_issues(args.repo)
    mapping: dict[str, int] = json.loads(MAP.read_text()) if MAP.exists() else {}

    for t in tickets:
        tid, title = t["ticket_id"], t["title"]
        body = (f"<!-- ticket:{tid} source:{t['file']} -->\n\n"
                f"**Ticket** `{tid}` · **Milestone** {t['milestone']} · "
                f"**Estimate** {t.get('estimate','—')}\n\n{t['body']}\n")
        labels = t.get("labels", [])
        if title in have:
            num = have[title]["number"]
            mapping[tid] = num
            print(f"  = #{num:<3} {tid}  (exists — syncing body)")
            if not dry:
                cmd = ["gh", "issue", "edit", str(num), "-R", args.repo, "--body", body]
                if t["milestone"] in ms:
                    cmd += ["--milestone", t["milestone"]]
                for l in labels:
                    cmd += ["--add-label", l]
                sh(cmd)
            continue
        print(f"  + {tid}  {title[:62]}")
        if dry:
            mapping.setdefault(tid, -1)
            continue
        cmd = ["gh", "issue", "create", "-R", args.repo, "--title", title, "--body", body]
        if t["milestone"] in ms:
            cmd += ["--milestone", t["milestone"]]
        for l in labels:
            cmd += ["--label", l]
        url = sh(cmd)
        mapping[tid] = int(url.rstrip("/").split("/")[-1])

    # Second pass: dependency cross-references, now that every id has a number.
    print("\ndependencies:")
    for t in tickets:
        deps = t.get("blocked_by", [])
        tid = t["ticket_id"]
        if not deps or tid not in mapping or mapping[tid] < 0:
            continue
        refs = ", ".join(f"#{mapping[d]}" for d in deps if d in mapping and mapping[d] > 0)
        if not refs:
            continue
        note = (f"**Blocked by:** {refs}\n\n"
                f"Do not start this ticket until every blocker is closed. "
                f"Verify with `/status` or `gh issue view <n>`.")
        print(f"  #{mapping[tid]:<3} {tid} blocked by {refs}")
        if not dry:
            sh(["gh", "issue", "comment", str(mapping[tid]), "-R", args.repo, "--body", note])

    MAP.write_text(json.dumps(dict(sorted(mapping.items())), indent=2) + "\n")
    print(f"\nwrote {MAP} ({len(mapping)} tickets)")
    print("COMMIT issue-map.json — it is how any new session resolves ticket ids to issue numbers.")


if __name__ == "__main__":
    main()
