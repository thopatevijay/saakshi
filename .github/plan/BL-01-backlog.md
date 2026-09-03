---
title: "BACKLOG — bugs, gaps, pitfalls & constraints found during implementation"
milestone: "Day 4 — Deploy & Submit"
labels: ["backlog", "meta"]
blocked_by: []
estimate: "running"
pinned: true
---

## Purpose

**Single running log for everything discovered mid-implementation that must not derail the ticket in flight.**

While working any ticket, if you hit a bug, a missing piece, a wrong assumption, a pitfall, an
external constraint, or a scope gap — **do not fix it inline and do not silently drop it.** Append
it here as a comment and carry on with the ticket you are on.

Use `/backlog "<note>"` to append. Every entry must state where it was found so it is traceable.

## Entry format

```
### <YYYY-MM-DD HH:MM> · found in <TICKET-ID> · <type>
**What:**        one line
**Impact:**      what breaks or is at risk
**Workaround:**  what we did instead (or "none — deferred")
**Action:**      fix now / fix Day 4 / accept as limitation / document in HLD
```

`<type>` ∈ `bug` · `gap` · `pitfall` · `constraint` · `assumption-wrong` · `perf` · `security` · `data-quality`

## Triage rule

- **Blocks the current ticket's AC** → fix now, and still log it here.
- **Breaks a later ticket** → log, and add a `blocker` note as a comment on that ticket.
- **Neither** → log and defer. Do not touch it.

## End-of-project use

Before submission this ticket is read in full and split into three lists:
1. **Fixed** — closed inline, referenced by commit
2. **Accepted limitations** → these go verbatim into the deck's *"What this system does not do"* slide
   and the HLD's *Assumptions & Constraints* section. This is where honesty scores points.
3. **Future roadmap** → these go into the deck's *Future Vision / Roadmap* dimension

## Acceptance Criteria

- [ ] Every entry follows the format above and names its source ticket
- [ ] At submission time, all entries are triaged into one of the three lists
- [ ] Accepted limitations appear in the deck and HLD
- [ ] Roadmap items appear in the Future Roadmap dimension

## Deliverables

- `docs/limitations.md` — generated from this ticket's accepted-limitation entries
- `docs/roadmap.md` — generated from this ticket's roadmap entries

## Validation Gate

- [ ] `docs/limitations.md` and `docs/roadmap.md` exist and are non-empty
- [ ] Zero untriaged entries remain
