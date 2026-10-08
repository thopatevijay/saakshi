-- Reverse of 0023. Only an index goes; no row is touched. The overlay's detections query falls back
-- to a sequential scan and gets slower; nothing else notices.
DROP INDEX IF EXISTS sightings_camera_pts_idx;
