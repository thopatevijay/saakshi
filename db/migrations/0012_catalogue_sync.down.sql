-- 0012 down · Reverses catalogue ingest.

DROP TABLE IF EXISTS catalogue_sync_runs;

DROP INDEX IF EXISTS cameras_catalogue_status_idx;

ALTER TABLE cameras
  DROP COLUMN IF EXISTS catalogue_status,
  DROP COLUMN IF EXISTS catalogue_last_seen_at,
  DROP COLUMN IF EXISTS catalogue_absent_since,
  DROP COLUMN IF EXISTS notes;

DROP TYPE IF EXISTS catalogue_status;
