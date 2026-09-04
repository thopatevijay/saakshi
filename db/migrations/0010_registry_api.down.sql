DROP INDEX IF EXISTS cameras_external_id_idx;

ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_department_external_uk;

-- Restoring the global unique fails if two departments have since imported the same external_id.
-- That is correct: rolling back past this migration is only possible while the data still fits the
-- older, narrower constraint.
ALTER TABLE cameras ADD CONSTRAINT cameras_external_id_key UNIQUE (external_id);

DROP INDEX IF EXISTS cameras_live_idx;
ALTER TABLE cameras DROP COLUMN IF EXISTS deleted_at;
