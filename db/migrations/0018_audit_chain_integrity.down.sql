-- Reverse of 0018.
--
-- Dropping `audit_log_prev_hash_uidx` removes the guarantee that the chain cannot fork; the rows
-- already written stay valid, but concurrent writers can fork it again from the next append on.
-- Dropping `seq` loses the deterministic walk order, and the identity counter does not resume from
-- where it left off if 0018 is re-applied — it restarts, which is harmless because nothing joins on
-- `seq`, but it means seq values are not comparable across a rollback.

DROP INDEX IF EXISTS audit_log_action_idx;
DROP INDEX IF EXISTS audit_log_prev_hash_uidx;
DROP INDEX IF EXISTS audit_log_seq_uidx;

ALTER TABLE audit_log
  DROP COLUMN IF EXISTS seq,
  DROP COLUMN IF EXISTS actor_role,
  DROP COLUMN IF EXISTS actor_badge_no;
