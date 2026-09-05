# Chain of custody

*How SAAKSHI records what was done, what that record proves, and — the part that matters most —
what it does **not** prove.*

Written for a reader who will test the claims: NFSU is a forensic-sciences university and a
knowledge partner to this challenge. Every sentence below is meant to survive being checked.

---

## 1. The claim, stated once and stated narrowly

**SAAKSHI's audit log is tamper-evident. It is not tamper-proof.**

A hash chain makes an *undetected* alteration impossible. It does not make alteration impossible.
Anyone with write access to the database and enough patience can rewrite every entry from a chosen
point onwards and produce a chain that verifies — the mathematics offers no defence against that,
here or anywhere else. What the chain guarantees is narrower and still useful:

| Attack | Detected? | How |
|---|---|---|
| Change one entry's payload | **Yes** | its stored hash no longer matches the digest of its contents |
| Delete an entry | **Yes** | the next entry no longer chains from its predecessor |
| Reorder entries | **Yes** | same — linkage is by hash, not by timestamp |
| Insert an entry in the middle | **Yes** | the inserted row's `prev_hash` cannot match both neighbours |
| Append a false entry at the tip | **No** | an append is a legitimate operation; what is recorded is *who* appended it |
| Rewrite the whole chain from entry *n* onward | **No, by hashing alone** | this is why append-only is enforced by the **database**, and why the deployed role cannot do it |

That last row is the honest limit, and it is why the mechanism has two layers rather than one.

---

## 2. Layer one — the database will not permit an edit

`audit_log` is append-only in PostgreSQL itself, not merely in application code (migration `0008`):

- **Grants.** The role the API connects as, `saakshi_app`, holds `SELECT` and `INSERT` on
  `audit_log` and nothing else. `UPDATE` and `DELETE` fail with `permission denied for table
  audit_log` before any trigger is reached.
- **Triggers.** `audit_log_no_update` and `audit_log_no_delete` fire `BEFORE UPDATE` / `BEFORE
  DELETE` and raise `restrict_violation` — *including for the table's owner*, who cannot be
  restricted by grants. The message is `audit_log is append-only: UPDATE is not permitted`.

Both are asserted on every test run (`packages/api/src/db/schema-drift.test.ts`), and the tamper
suite has to **disable a trigger** before it can stage a tamper at all
(`packages/api/src/services/audit-tamper.test.ts`). That is worth stating plainly: an attacker
cannot quietly edit a row. They must first disable a guard that appears in any schema diff — and
then the hash still gives them away.

```bash
psql "$DATABASE_URL" -c "update audit_log set purpose='x' where id = (select id from audit_log limit 1);"
# ERROR:  audit_log is append-only: UPDATE is not permitted
```

---

## 3. Layer two — the hash chain

Each entry carries the hash of the one before it:

```
hash₀ = SHA256( "genesis" ‖ canonical_json(entry₀) )
hashₙ = SHA256( hashₙ₋₁  ‖ canonical_json(entryₙ) )
```

`prev_hash` is either 64 hex characters or the literal `genesis`, and a canonical document always
begins with `{`, so the concatenation cannot be made ambiguous by choosing a clever payload.

### What is inside `canonical_json(entry)`

Exactly these eleven fields, always present, `null` where empty — so "absent" and "null" cannot hash
differently:

```json
{
  "action": "trace.run",
  "actorBadgeNo": "GP-SUP-0100",
  "actorId": "…uuid…",
  "actorRole": "supervisor",
  "caseRef": "FIR/2026/00123",
  "params": { "…the query as it was run…" },
  "purpose": "FIR follow-up: reconstructing vehicle movement",
  "resultCount": 6,
  "targetId": "GJ01AB1234",
  "targetType": "vehicle",
  "ts": "2026-09-05T09:00:00.000Z"
}
```

`actorBadgeNo` and `actorRole` are stored **on the entry**, not joined from `users` at read time.
`audit_log.actor_id` is `ON DELETE SET NULL`, so without them, removing a user's account would
silently strip the actor from every entry they ever wrote. They are inside the hash, so they cannot
be back-filled afterwards either.

### Canonical JSON — the whole integrity guarantee

`packages/shared/src/canonical-json.ts`. A hash is only evidence if two people who disagree about
what happened can compute it independently and get the same answer, so the serialisation is pinned
down rather than left to `JSON.stringify`:

1. **Object keys sorted** by UTF-16 code unit; `undefined`-valued properties omitted.
2. **Numbers** in JavaScript's shortest round-tripping form; `-0` normalised to `0`; `NaN` and
   `±Infinity` throw rather than becoming `null`.
3. **Dates** as `toISOString()` — UTC, three fractional digits.
4. **`undefined` / functions / symbols in an array** become `null`, preserving length.
5. **`bigint` throws.** There is no agreed JSON encoding, and silently picking one would make that
   file the only place that knows.
6. **Cycles throw.**
7. **`toJSON()` is not honoured** except on `Date`. An object that can rewrite itself on the way into
   a hash is an object that can be made to hash differently without its visible fields changing.

This is not tidiness. `params` is a `jsonb` column, and **Postgres returns `jsonb` in its own key
order** — so a digest taken over `JSON.stringify` of the object a route built cannot be reproduced
from the row a verifier reads back. That was the state of the chain before D3-04: every entry with a
multi-key `params` was unverifiable, and it would have failed *looking exactly like tampering*.

A property test asserts the two things that matter: 200 shuffled key insertion orders of the same
entry serialise byte-identically, and a **separate Node process** handed the re-parsed value produces
the same bytes and the same SHA-256.

### The chain cannot fork

Reading the tip and then inserting is not atomic. Under `READ COMMITTED`, two concurrent
transactions read the same tip and write two entries with the same `prev_hash` — the chain becomes a
tree, and verification reports that in a way indistinguishable from tampering. There are at least
three concurrent writers in this system already (parallel test suites, the prober sweep, the
scheduled catalogue sync), and D1-06 (#10) found this before it could reach a demonstration.

The fix is a database constraint rather than a lock. Migration `0018` adds:

```sql
CREATE UNIQUE INDEX audit_log_prev_hash_uidx ON audit_log (prev_hash);
```

At most one entry may chain off any given predecessor, `genesis` included. A concurrent writer that
lost the race gets a unique-violation, and `writeAudit` retries it against the new tip inside a
nested transaction — so a caller who passed in their own transaction gets a savepoint rollback rather
than a poisoned transaction. A fork is not made *unlikely*; it is made **impossible**, which is a
property anyone can check with one query rather than by reading code.

`0018` also adds `seq` (`GENERATED ALWAYS AS IDENTITY`), giving the writer an O(1) tip and the
verifier a walk order that does not depend on a wall clock. Because the unique index forces writers
to serialise, `seq` order *is* link order.

---

## 4. Entries written before this mechanism existed

Entries appended before D3-04 used a positional `JSON.stringify([...])` preimage whose `params`
element was serialised in the **writer's** insertion order. As §3 explains, that cannot be
recomputed from the stored row — by us or by anyone.

Rather than let a verifier open by reporting a breach on rows nobody touched, the boundary is made
explicit. `npm run audit:verify -- --seal` appends one ordinary chain entry:

```
action      chain.epoch
targetType  audit_chain
params      { preCanonicalEntries: N, boundaryHash: "…", algorithm: "sha256(prev_hash || canonical_json(entry))" }
```

That entry is hashed canonically like every other, so the size of the prologue is *inside* the chain
and cannot be widened afterwards. Verification does not take it on trust either: it **computes** the
prologue as the maximal leading run of entries that fail the canonical digest, and then requires the
sealed figures to agree. An attacker who tampered with entries 2–10 to enlarge the exempt region
would move the computed boundary away from the sealed one, and that disagreement is itself the break.

**What is claimed for pre-canonical entries:** their position in the chain is verified — a deletion,
a reordering or an insertion around them is still detected. Their payloads are **not** re-hashable
and are never reported as verified. The chain viewer labels them `pre-canonical`, in amber, with
that sentence.

A database migrated from empty has no prologue and never needs an epoch. `saakshi_d3_04` carries
exactly one such entry, from a catalogue sync that predates this ticket.

---

## 5. Purpose binding

> A search of a citizen's movements with no stated reason is the thing this system exists to make
> impossible.

Enforced **server-side**, not in the UI:

| Endpoint | Requires |
|---|---|
| `GET /api/v1/trace`, `/trace.csv`, `/trace.pdf` | `purpose` — 400 without it |
| `GET /api/v1/plates/search` | `purpose` — 400 without it |
| `POST /api/v1/audit/export` | `purpose` **and** `case_ref` — 400 without either |

Every one of those writes its own chain entry carrying the stated purpose, the officer's badge and
role, the parameters as they were run, and the number of results.

**A link cannot state a purpose — only a person can.** D2-07's "trace this vehicle" link carries the
registration and the time window and deliberately carries no purpose; `/trace` lands with the field
waiting and searches nothing until it is answered.

### What purpose binding proves, and what it does not

It proves that a purpose was **stated and recorded against the officer who stated it**, in an
append-only chain, before the search ran. It does **not** prove the purpose was true. A length check
cannot assess substance, and pretending it could would manufacture exactly the false confidence this
document exists to avoid. What it changes is that an unaccountable query becomes a record an auditor
can read back and challenge — which is the mechanism that actually deters misuse.

---

## 6. The auditor role

`packages/shared/src/rbac.ts` is the single definition; the API derives its role lists from `can()`
rather than restating them.

| | admin | supervisor | operator | auditor |
|---|---|---|---|---|
| `audit:read` | ✓ | ✓ | | ✓ |
| `audit:export` | ✓ | ✓ | | ✓ |
| `trace:run` | ✓ | ✓ | ✓ | |
| `alerts:view` | ✓ | ✓ | ✓ | |
| `video:view` | ✓ | ✓ | ✓ | |
| `registry:write` | ✓ | ✓ | | |

An auditor reads and verifies the chain and does nothing else. No live video, no vehicle traces, no
plate searches, no alert queue, no registry writes — "an auditor who can change the thing being
audited is not an auditor", and one who can walk out with the evidence is not one either.

**Building an evidence bundle needs both `trace:run` and `audit:export`**, and the conjunction is the
point: the first says you may look at this evidence, the second says you may take something out of
the building. An operator has the first and not the second; an auditor has the second and not the
first. That leaves admin and supervisor.

D3-04 closed two gaps where the server was more permissive than this table: `/api/v1/plates/search`
and the alert-queue read endpoints were gated on `READ_ROLES` — every signed-in role, auditor
included — while the navigation hid both screens from an auditor. The server is the authoritative
side, so the server moved.

---

## 7. Export bundles

An evidence bundle is a directory, not an archive, so anyone can open it with anything:

```
exports/FIR-2026-00123-GJ01AB1234-2026-09-05T12-29-38/
  manifest.json      every item, its byte length and its SHA-256, in canonical JSON
  manifest.sha256    the SHA-256 of manifest.json's own bytes
  verify.mjs         `node verify.mjs` — zero dependencies
  README.txt         what this proves and what it does not
  trace.json         the trace exactly as the API returned it
  trace.csv          the same rows, for a spreadsheet
  evidence/*.jpg     the crops, as bytes
```

### Verify it with nothing but Node

```bash
node exports/<bundle>/verify.mjs
# bundle      FIR-2026-00123-GJ01AB1234-2026-09-05T12-29-38
# items       8 of 8 verified
# PASS — every file matches the manifest, and the manifest matches its hash.
```

No install, no network, no access to the system that built it. That is deliberate: the person who
most needs to check a bundle is the one who does not have the system that produced it.

### Three design rules, each of which was got wrong somewhere first

**A signed URL is never written into a bundle.** A presigned object-store URL is a credential with an
expiry; a bundle carrying one ships a link that is dead before anyone opens it, and it *looks real*
while being useless. Crops are embedded as **bytes**, fetched through a URL minted, used and
discarded inside the build. A test asserts no bundle file contains `X-Amz-Signature`.

**A missing crop is recorded, never dropped.** `crop_uri` may be `null` — only best shots have a
crop, roughly 1 sighting in 30 — and a stored URI may be one this object store cannot serve. Both
appear under `omissions` with a reason (`no_crop_stored`, `object_store_unconfigured`,
`uri_not_servable`, `fetch_failed`). A bundle that silently omitted the sightings it had no crop for
would misrepresent the evidence that existed.

**The manifest's hash is the hash of its own bytes.** `manifest.json` is written in canonical JSON,
so it is reproducible — but the bundle's verifier does not reproduce it, it hashes the file. That is
why `verify.mjs` carries no JSON canonicaliser and cannot drift from ours on a whitespace question.

### What bundle verification proves

That the bundle is **byte-for-byte unaltered since it was built**. Not that its contents are true:
sightings are observed detections, that they are the same vehicle is an inferred link with a stated
confidence, and the path between them is inferred entirely.

The manifest names the audit entry that authorised the export (`chain.auditEntryHash`) and the chain
tip at that moment. That is what ties the package to an accountable officer, a stated purpose and a
case reference; the hashes tie the package to its own contents. Two different questions, two
different answers.

### What a bundle never implies

Every bundle carries, in `manifest.json` and in `README.txt`:

> MOCK PROVIDERS — SAAKSHI has no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity, and
> performs no face recognition or other biometric processing. Nothing in this bundle is an
> identification of a person, and no external registry was consulted to produce it.

---

## 8. Running it

```bash
npm run audit:verify                     # PASS/FAIL, exit 0 or 1
npm run audit:verify -- --json           # the same as a machine-readable document
npm run audit:verify -- --seal           # once, on a database with pre-D3-04 entries

npm run export:bundle -- --trace GJ01AB1234 --case FIR/2026/00123
npm run export:verify -- ./exports/<bundle>
node ./exports/<bundle>/verify.mjs       # the same check, with no repository

npm run test -w packages/api -- audit          # the chain, purpose binding, bundles, RBAC
npm run test -w packages/api -- audit-tamper   # the tamper cases
```

In the product: **Audit** in the left navigation (`audit:read`), which shows the verification banner,
the first broken link if there is one, and the chain itself filtered by actor, action, case reference
or time.

---

## 9. Where this is implemented

| Concern | File |
|---|---|
| Canonical JSON | `packages/shared/src/canonical-json.ts` |
| Digest, append, verification, search, epoch | `packages/api/src/services/audit.ts` |
| Export bundles and their verifier | `packages/api/src/services/export-bundle.ts` |
| HTTP surface | `packages/api/src/routes/audit.ts`, `audit-contracts.ts` |
| CLIs | `packages/api/src/jobs/{audit-verify,export-bundle-cli,export-verify}.ts` |
| Append-only enforcement | `db/migrations/0008_audit_export.up.sql` |
| Fork prevention, `seq`, actor capture | `db/migrations/0018_audit_chain_integrity.up.sql` |
| Chain viewer | `packages/web/app/(shell)/audit/` |
| Role matrix | `packages/shared/src/rbac.ts` |
