-- 0014 down · Reverses vehicle attributes and evidence store.
--
-- `vehicle_color`, `vehicle_type` and `crop_uri` are NOT dropped: they belong to 0004 and predate
-- this migration. Rolling back 0014 removes the confidence and the best-shot flag, which is
-- everything 0014 added.

DROP INDEX IF EXISTS sightings_best_shot_idx;

ALTER TABLE sightings
  DROP COLUMN IF EXISTS vehicle_color_confidence,
  DROP COLUMN IF EXISTS attributes_low_confidence,
  DROP COLUMN IF EXISTS is_best_shot;
