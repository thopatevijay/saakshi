-- 0010 · What the registry API needs that 0003 did not provide.
--
-- Two changes, both required by D1-02's spec rather than by taste.

-- ── 1 · Soft delete ─────────────────────────────────────────────────────────────────────────────
-- "DELETE /api/v1/cameras/:id — soft delete (never hard)". A camera that was decommissioned is
-- still the provenance of every sighting and every alert already attached to it, so the row cannot
-- go. Reads filter on deleted_at IS NULL; DELETE sets it.
ALTER TABLE cameras ADD COLUMN deleted_at timestamptz;

-- Partial index: the overwhelming majority of queries want live cameras only, and a partial index
-- keeps them off the decommissioned rows entirely.
CREATE INDEX cameras_live_idx ON cameras (id) WHERE deleted_at IS NULL;

-- ── 2 · Upsert key ──────────────────────────────────────────────────────────────────────────────
-- D1-02 requires the catalogue upsert to key on (department_id, external_id): two departments can
-- legitimately both call a camera "cam01", and 0003's global UNIQUE(external_id) made the second
-- department's camera unimportable.
--
-- NULLS NOT DISTINCT (PostgreSQL 15+, we run 16.14) is load-bearing. department_id is nullable, and
-- under the default NULLS DISTINCT a composite unique constrains nothing at all for rows with no
-- department — re-running the catalogue import would duplicate every unassigned camera silently,
-- which is exactly the failure the AC tests for.
ALTER TABLE cameras DROP CONSTRAINT cameras_external_id_key;

ALTER TABLE cameras
  ADD CONSTRAINT cameras_department_external_uk
  UNIQUE NULLS NOT DISTINCT (department_id, external_id);

-- external_id alone is still the common lookup (the sandbox knows cameras only by `cam09`), and it
-- is no longer the leading column of a unique index, so it needs its own.
CREATE INDEX cameras_external_id_idx ON cameras (external_id);
