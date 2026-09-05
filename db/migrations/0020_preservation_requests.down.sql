-- Reverse of 0020.
--
-- The requests go; the audit-chain entries that authorised them do not, and must not — `audit_log`
-- is append-only by trigger, and a chain that could be pruned by dropping an unrelated table would
-- not be tamper-evident. After this migration those entries name a `preservation_request` target
-- that no longer resolves, which is the correct outcome: the record of the act survives the record
-- of its subject.

DROP TABLE IF EXISTS preservation_requests;
DROP TYPE IF EXISTS preservation_status;
