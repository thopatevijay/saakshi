-- Reverse of 0017. Every cached route loses its key, so the next request rebuilds from OSRM rather
-- than serving a stale answer — the rollback is slow, never wrong.

DROP INDEX IF EXISTS route_segments_kind_idx;

ALTER TABLE route_segments
  DROP COLUMN IF EXISTS note,
  DROP COLUMN IF EXISTS confidence_basis,
  DROP COLUMN IF EXISTS path_options,
  DROP COLUMN IF EXISTS straight_line_m,
  DROP COLUMN IF EXISTS road_distance_m,
  DROP COLUMN IF EXISTS elapsed_s,
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS to_camera_id,
  DROP COLUMN IF EXISTS from_camera_id;

DROP INDEX IF EXISTS routes_cache_key_uidx;

ALTER TABLE routes
  DROP COLUMN IF EXISTS summary,
  DROP COLUMN IF EXISTS build_ms,
  DROP COLUMN IF EXISTS built_at,
  DROP COLUMN IF EXISTS sighting_count,
  DROP COLUMN IF EXISTS sightings_fingerprint,
  DROP COLUMN IF EXISTS cache_key;
