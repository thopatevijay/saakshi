-- 0018 · The two things a hash chain needs from the database, and one index for the auditor (D3-04).
--
-- 0008 gave `audit_log` append-only enforcement — grants plus BEFORE UPDATE/DELETE triggers — which
-- stops a row being *changed*. It does not stop the chain being *forked*, and a forked chain is the
-- more dangerous failure, because verification reports it in a way indistinguishable from tampering.
--
-- 1 · `UNIQUE (prev_hash)` — the chain cannot fork, as a database constraint.
--
--     D1-06 (#10) raised this against `writeAudit`: it reads the tip and then inserts, so under READ
--     COMMITTED two concurrent transactions read the *same* tip and write two rows carrying the same
--     `prev_hash`. There are at least three concurrent writers already (parallel vitest suites, the
--     prober sweep, the scheduled catalogue sync). A fork makes the first thing the chain viewer
--     reports a breach that never happened, which is worse than having no tamper evidence at all.
--
--     A lock would have made the race less likely. A unique index makes the fork *impossible*: the
--     second writer's INSERT fails on the constraint and retries against the new tip. That is a
--     property a judge can check with one query, rather than a property of code they have to read.
--
--     Two rows may share a `prev_hash` of NULL under a unique index, but `prev_hash` is NOT NULL
--     here, so the genesis link is covered too: exactly one row may chain off 'genesis'.
--
-- 2 · `seq` — a deterministic chain order that does not depend on a clock.
--
--     The tip was previously selected by `order by ts desc, hash desc`. `ts` is wall-clock: two rows
--     written in the same millisecond tie, and the tiebreak (hash order) has nothing to do with
--     insertion order. An identity column gives the writer an O(1) tip and gives the verifier a
--     stable walk order, and because the unique index above forces writers to serialise, `seq` order
--     and chain order are the same order.
--
--     GENERATED ALWAYS, so nothing can supply one. Existing rows are numbered in physical order.
--
-- 3 · `actor_badge_no` / `actor_role` — the entry has to be self-describing.
--
--     The ticket requires every entry to record "actor id + badge, role". 0008 records only
--     `actor_id`, with `ON DELETE SET NULL` — so removing a user's row silently strips the actor
--     from every audit entry they ever wrote, and the badge and role were never stored at all, only
--     joinable. An audit record that loses who made it when personnel data changes is not a chain of
--     custody. Both are captured at write time, from the principal on the request, and both are
--     inside the hash, so neither can be back-filled afterwards.
--
--     NULL for both means a *system* actor — the alert engine raising an alert with no operator in
--     the loop — which is a real and distinct case from "an officer whose account was deleted".
--
-- 4 · `audit_log_action_idx` — the auditor's chain viewer searches by actor, action, case reference
--     and time. Three of the four already had an index (0008); `action` did not.

ALTER TABLE audit_log
  ADD COLUMN actor_badge_no text,
  ADD COLUMN actor_role text,
  ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;

CREATE UNIQUE INDEX audit_log_seq_uidx ON audit_log (seq);

CREATE UNIQUE INDEX audit_log_prev_hash_uidx ON audit_log (prev_hash);

CREATE INDEX audit_log_action_idx ON audit_log (action);

COMMENT ON COLUMN audit_log.actor_badge_no IS
  'Badge number as it stood at write time. NULL means a system actor, not a deleted user (D3-04).';
COMMENT ON COLUMN audit_log.actor_role IS
  'Role as it stood at write time. NULL means a system actor, not a deleted user (D3-04).';
COMMENT ON COLUMN audit_log.seq IS
  'Insertion order. The chain walks in this order; audit_log_prev_hash_uidx guarantees it is also link order.';
COMMENT ON INDEX audit_log_prev_hash_uidx IS
  'The chain cannot fork: at most one entry may chain off any given predecessor (D3-04).';
