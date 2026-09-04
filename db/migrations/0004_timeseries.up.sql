-- 0004 · The two Timescale hypertables: camera_health_checks and sightings.
--
-- Both are append-heavy time series. At the sizing in PROJECT.md §9 a per-camera probe every few
-- minutes plus every vehicle detection on every camera is the bulk of the row count in the system.
--
-- Timescale requires the partitioning column to be part of every UNIQUE/PRIMARY KEY constraint on
-- the table, so both carry composite primary keys that include the time column.

CREATE TABLE camera_health_checks (
  camera_id  uuid NOT NULL REFERENCES cameras (id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),

  connectable boolean NOT NULL,
  decodable   boolean NOT NULL,

  -- MEASURED, not declared. Never trust CAP_PROP_FPS; the delta against cameras.declared_fps is
  -- what Pillar 1 reports.
  measured_fps      numeric(6, 2),
  actual_resolution text,
  actual_codec      text,

  -- Classical CV trust signals — deterministic, explainable, cheap at 80k cameras.
  blur_score   numeric(10, 3),
  luma_mean    numeric(6, 2),
  night_usable boolean,
  tamper_score numeric(6, 3),
  -- Presentation-timestamp drift. The gateway replays a buffered GOP on connect, so an
  -- arrival-time clock reports impossible values after every reconnect; this is measured from PTS.
  pts_drift_ms integer,

  trust_score numeric(5, 2) CHECK (trust_score IS NULL OR (trust_score >= 0 AND trust_score <= 100)),
  -- Per-component contribution, so the score is explainable in the UI rather than a bare number.
  breakdown   jsonb NOT NULL DEFAULT '{}'::jsonb,

  PRIMARY KEY (camera_id, checked_at)
);

SELECT create_hypertable(
  'camera_health_checks', 'checked_at',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

-- No explicit index on checked_at: create_hypertable already builds a DESC index on the
-- partitioning column, and names it `camera_health_checks_checked_at_idx`. Declaring it again
-- fails with `relation already exists`. (Same for `sightings_ts_idx` below.)

-- "How is this camera doing lately" — the trust dashboard's query.
CREATE INDEX camera_health_checks_camera_checked_at_idx
  ON camera_health_checks (camera_id, checked_at DESC);

CREATE TABLE sightings (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  camera_id  uuid NOT NULL REFERENCES cameras (id) ON DELETE CASCADE,
  ts         timestamptz NOT NULL,

  -- Presentation timestamp of the source frame, in milliseconds from the start of the stream.
  -- Timing comes from PTS, never frame arrival time.
  frame_pts_ms bigint NOT NULL,
  -- Tracker-local id. Feeds loop, and a hard scene cut is normal: track ids reset at the cut and
  -- must not bleed across it, so this is only unique within (camera_id, a tracking session).
  track_id     integer NOT NULL,

  class          vehicle_class NOT NULL,
  bbox           jsonb NOT NULL,
  det_confidence numeric(4, 3) NOT NULL CHECK (det_confidence >= 0 AND det_confidence <= 1),

  vehicle_color text,
  vehicle_type  text,
  crop_uri      text,

  ingested_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (id, ts)
);

SELECT create_hypertable(
  'sightings', 'ts',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- The trace query: "everything this camera saw, most recent first".
CREATE INDEX sightings_camera_ts_idx ON sightings (camera_id, ts DESC);
CREATE INDEX sightings_track_id_idx ON sightings (track_id);
CREATE INDEX sightings_class_idx ON sightings (class);
