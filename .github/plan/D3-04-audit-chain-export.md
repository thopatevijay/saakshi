---
title: "D3-04 · Tamper-evident audit chain and export bundles"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "backend", "pillar-4", "security", "differentiator"]
blocked_by: ["D1-01", "D2-02"]
estimate: "3h"
---

## Context

**NFSU — a forensic sciences university — is a knowledge partner and helps evaluate submissions.**
Speak their language: chain of custody, tamper evidence, admissibility.

This is also the honest answer to the responsible-surveillance question. Not a lecture — a mechanism.

## Scope

- Hash chain over `audit_log`: `hash_n = SHA256(prev_hash ‖ canonical_json(entry))`
  - Canonical JSON serialisation (stable key order, defined number/date formats) — this is the whole
    integrity guarantee, so it must be exact and tested
  - Genesis entry at chain head
- Every entry records: actor id + badge, role, action, target, **purpose**, case/FIR reference,
  parameters, result count, timestamp
- **Purpose binding**: searches and traces require a stated purpose; exports additionally require a
  case reference. Enforced server-side.
- Chain verification endpoint + CLI: walks the chain and reports the first broken link, if any
- Append-only enforced at the database level (from D1-01), not just in application code
- **Export bundles**: selected evidence (crops, sightings, route, alerts) packaged with a
  `manifest.json` listing every item's SHA-256, plus a `manifest_hash`. Bundle integrity is
  independently verifiable later by anyone with the bundle.
- Auditor role: read-only chain viewer with search by actor, action, case reference, time

## Acceptance Criteria

- [ ] Every mutating action and every search/trace/export writes an audit entry
- [ ] Canonical serialisation is deterministic — property test: same entry serialises identically
      across processes and key insertion orders
- [ ] Chain verification passes on a healthy chain
- [ ] **Tamper test**: modify one entry's payload directly in the database; verification identifies
      that exact entry as the first broken link
- [ ] Database-level append-only proven: `UPDATE`/`DELETE` as the app role raise errors
- [ ] Search without a purpose is rejected (400), server-side
- [ ] Export without a case reference is rejected, server-side
- [ ] Export bundle produced; every crop's hash verifies; `manifest_hash` verifies
- [ ] Re-verifying an untouched bundle passes; altering one byte of one crop fails verification at
      that file
- [ ] Auditor can read the chain and can do nothing else (RBAC test)

## Deliverables

- `packages/api/src/services/audit.ts`, `export-bundle.ts`
- `npm run audit:verify` CLI
- `packages/web/app/audit/*` viewer
- `docs/chain-of-custody.md` — the mechanism, the threat model, what it does and does **not** prove
  (it proves tamper *evidence*, not tamper prevention — state that plainly)

## Validation Gate

```bash
npm run test -w packages/api -- audit
npm run audit:verify                 # PASS
npm run test -w packages/api -- audit-tamper   # detects the seeded tamper
npm run export:bundle -- --trace <id> --case FIR/2026/00123
npm run export:verify -- ./exports/<bundle>    # PASS
psql $DATABASE_URL -c "update audit_log set purpose='x' where id=1;"   # must ERROR
```

- [ ] Tamper detection identifies the right entry
- [ ] Bundle verify passes clean and fails on a single-byte alteration
- [ ] Database-level append-only rejection observed

## Handoff → D4-04, D4-05

This is the strongest slide for the NFSU-informed part of the jury. Screenshot the chain viewer and
a verified bundle.
