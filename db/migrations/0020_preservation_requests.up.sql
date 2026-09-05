-- 0020 · Preservation requests (D3-05).
--
-- An officer looking at the retention clock can see that a camera's footage expires in 31 hours.
-- The clock is only half the feature; the other half is being able to *do* something about it, and
-- what can honestly be done is: record the request, bind it to a case, make it auditable, and put
-- it on a queue the owning department can work.
--
-- ## What this table is NOT
--
-- It is not a retention extension. SAAKSHI does not operate any department's NVR, VMS or cloud
-- recorder, and nothing in this schema reaches one. The row is an *instruction*, and every surface
-- that renders it carries `PRESERVATION_DISCLAIMER` from `@saakshi/shared` saying so in those
-- words. A table called `preservation_requests` that silently implied footage was safe would be the
-- single most damaging over-claim in the build — an officer would stop chasing the department.
--
-- ## Why the audit entry is a column and not a second audit table
--
-- D3-04 (#27) built the tamper-evident chain: `audit_log` with `seq GENERATED ALWAYS` and
-- `UNIQUE (prev_hash)` so it cannot fork. "Who asked for this footage to be kept, when, on whose
-- authority, under which case" is an auditable act in exactly that sense, so it is appended to that
-- chain by `writeAudit` inside the same transaction as the insert below. `audit_hash` here is the
-- chain entry's hash — a pointer *into* the chain, not a parallel record of it. A second audit
-- trail would be a second thing to keep honest, and the two would eventually disagree.
--
-- ## Why the retention figures are snapshotted
--
-- `retention_days_at_request` and `expires_at_at_request` record what the registry said **at the
-- moment the request was made**. If a department later corrects its declared retention from 7 days
-- to 15, the queue must still show what the officer was told when they acted, or the record stops
-- explaining the decision it was made to explain. The live figure is always recomputable from
-- `cameras.retention_days`; the historical one is not.
--
-- Both are nullable, because `NULL` retention is the *normal* case on this estate (all 30 sandbox
-- cameras declare none) and a preservation request against footage of unknown lifetime is the most
-- urgent kind there is — refusing to record it would be exactly backwards.

CREATE TYPE preservation_status AS ENUM (
  -- Recorded here, not yet acknowledged by the owning department.
  'open',
  -- The department has confirmed receipt. Set through the API by a supervisor relaying that
  -- confirmation; SAAKSHI has no channel that could learn it on its own.
  'acknowledged',
  -- The department has confirmed the footage is held.
  'preserved',
  -- The department declined, or the footage was already gone.
  'declined'
);

CREATE TABLE IF NOT EXISTS preservation_requests (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id                 uuid NOT NULL REFERENCES cameras (id) ON DELETE CASCADE,

  -- The evidence window the officer wants held, in wall-clock time. Not a sighting id: the request
  -- is about *footage on a recorder*, which exists whether or not SAAKSHI ever produced a sighting
  -- from it, and the department is being asked to hold a span of tape, not a database row.
  window_start              timestamptz NOT NULL,
  window_end                timestamptz NOT NULL,

  -- Mandatory, unlike on a search. A request that asks another department to change what it does
  -- with evidence has to name the case it is for; "because I asked" is not a reason anybody can
  -- audit later. Same character class as D3-04's export case refs.
  case_ref                  text NOT NULL,
  purpose                   text NOT NULL,

  requested_by              uuid REFERENCES users (id) ON DELETE SET NULL,
  requested_at              timestamptz NOT NULL DEFAULT now(),

  status                    preservation_status NOT NULL DEFAULT 'open',

  -- What the registry declared when the request was made. NULL means it declared nothing.
  retention_days_at_request integer,
  expires_at_at_request     timestamptz,

  -- The `audit_log.hash` of the chain entry that authorised this request. Not a foreign key: the
  -- chain is append-only and hash-addressed, and a FK to `audit_log.hash` would let a cascade
  -- rewrite reach it. Verifying the pointer is a chain-verification concern, not a constraint.
  audit_hash                text NOT NULL,

  notes                     text,

  CONSTRAINT preservation_requests_window_ordered CHECK (window_end > window_start),
  CONSTRAINT preservation_requests_case_ref_shape CHECK (case_ref ~ '^[A-Za-z0-9/\-_.]{3,64}$'),
  CONSTRAINT preservation_requests_purpose_length CHECK (char_length(purpose) BETWEEN 3 AND 500),
  CONSTRAINT preservation_requests_retention_days_check
    CHECK (retention_days_at_request IS NULL OR retention_days_at_request >= 0)
);

-- The queue is read "open first, most urgent first", and filtered by case when an officer is
-- assembling one file. Two narrow indexes rather than one wide one: the queue view and the case
-- view are different questions.
CREATE INDEX preservation_requests_queue_idx
  ON preservation_requests (status, expires_at_at_request NULLS FIRST, requested_at DESC);
CREATE INDEX preservation_requests_case_ref_idx ON preservation_requests (case_ref);
CREATE INDEX preservation_requests_camera_idx ON preservation_requests (camera_id);

COMMENT ON TABLE preservation_requests IS
  'D3-05. An instruction to the owning department to hold footage, bound to a case and appended to '
  'the D3-04 audit chain. NOT a retention extension: SAAKSHI does not operate the recorder.';

COMMENT ON COLUMN preservation_requests.audit_hash IS
  'audit_log.hash of the chain entry that authorised this request (D3-04). A pointer into the '
  'chain, deliberately not a foreign key.';

COMMENT ON COLUMN preservation_requests.retention_days_at_request IS
  'What cameras.retention_days said when the request was made. NULL = the department declared '
  'none, which is the normal case on the sandbox estate and the most urgent kind of request.';
