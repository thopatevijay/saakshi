-- Reverse of 0016. `match_distance` returns to `integer`, which ROUNDS every fuzzy distance — the
-- rollback is lossy by nature and that is stated here rather than discovered later.

DROP TABLE IF EXISTS alert_digests;

DROP INDEX IF EXISTS alerts_dedupe_key_last_seen_idx;
DROP INDEX IF EXISTS alerts_last_seen_idx;

ALTER TABLE alerts
  DROP COLUMN IF EXISTS status_changed_by,
  DROP COLUMN IF EXISTS status_changed_at,
  DROP COLUMN IF EXISTS last_observed_plate,
  DROP COLUMN IF EXISTS sighting_count,
  DROP COLUMN IF EXISTS last_sighting_ts,
  DROP COLUMN IF EXISTS last_sighting_id,
  DROP COLUMN IF EXISTS last_seen_at;

ALTER TABLE alerts
  ALTER COLUMN match_distance TYPE integer USING round(match_distance)::integer;
