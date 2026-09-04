-- 0008 · Tamper-evident audit chain, export bundles, department onboarding responses.
--
-- The audit chain is the evidentiary backbone (D3-04): every query against personal data is
-- recorded with its purpose and case reference, and each row hashes the previous row's hash, so a
-- deleted or edited entry breaks the chain verifiably.

-- The application role. Deliberately less privileged than `saakshi`, which owns the database:
-- an owner cannot be restricted by grants, so proving append-only requires a separate role.
-- Created NOLOGIN here; D4-01 gives it a password from the deploy environment. Nothing in the
-- repository ever holds that password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saakshi_app') THEN
    CREATE ROLE saakshi_app NOLOGIN;
  END IF;
END
$$;

CREATE TABLE audit_log (
  id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts  timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users (id) ON DELETE SET NULL,

  action      text NOT NULL,
  target_type text NOT NULL,
  target_id   text,

  -- Why the officer ran this query, and under which case. Not optional: a search of a citizen's
  -- movements without a stated purpose is exactly what this table exists to make impossible.
  purpose  text NOT NULL,
  case_ref text,

  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_count integer,

  -- The chain. `prev_hash` is the genesis constant for the first row, so both are NOT NULL and the
  -- chain has no nullable break in it.
  prev_hash text NOT NULL,
  hash      text NOT NULL UNIQUE
);

CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id);
CREATE INDEX audit_log_case_ref_idx ON audit_log (case_ref) WHERE case_ref IS NOT NULL;

-- ── Append-only guard, two independent layers ───────────────────────────────────────────────────
-- Layer 1: grants. The app role may INSERT and SELECT, nothing else.
REVOKE ALL ON audit_log FROM saakshi_app;
GRANT SELECT, INSERT ON audit_log TO saakshi_app;

-- Layer 2: a trigger, so even a role that somehow holds UPDATE/DELETE is refused. Grants can be
-- changed by an administrator in a hurry; a trigger is part of the schema and shows up in a diff.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
-- ────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE export_bundles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  items    jsonb NOT NULL DEFAULT '[]'::jsonb,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Hash of the manifest, so a bundle handed to a court can be checked against what was exported.
  manifest_hash text NOT NULL
);

CREATE INDEX export_bundles_created_at_idx ON export_bundles (created_at DESC);
CREATE INDEX export_bundles_created_by_idx ON export_bundles (created_by);

-- Model 1 deliverable (D4-06): the department onboarding questionnaire, stored as submitted.
CREATE TABLE onboarding_responses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES departments (id) ON DELETE CASCADE,
  questionnaire jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX onboarding_responses_department_idx ON onboarding_responses (department_id);

-- Baseline grants for everything else: the app reads and writes normally.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  departments, users, cameras, camera_coverage, road_network,
  camera_health_checks, sightings, plate_reads, vehicle_identities, identity_sightings,
  watchlist_entries, alerts, routes, route_segments, export_bundles, onboarding_responses
  TO saakshi_app;
GRANT USAGE ON SCHEMA public TO saakshi_app;
