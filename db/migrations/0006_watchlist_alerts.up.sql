-- 0006 · Watchlist and alerts. Pillar 4 — what a control room actually uses daily.

CREATE TABLE watchlist_entries (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category watchlist_category NOT NULL,
  entity_type watchlist_entity_type NOT NULL,

  -- Set for entity_type='vehicle'. Normalised by the same D2-03 grammar that normalises reads, so
  -- an exact match is a string equality and a fuzzy match is a trigram/levenshtein comparison over
  -- like-for-like text.
  plate_normalized text,
  -- Set for entity_type='person'. An opaque case reference, never biometric data: SAAKSHI performs
  -- no face recognition and stores no biometrics.
  person_ref       text,

  -- The connector this entry is modelled on. There is NO live VAHAN / SARTHI / eGujCop / AFIS /
  -- NAFIS connectivity — a mock provider serves these (D2-05). Never present as a live integration.
  source_system source_system NOT NULL DEFAULT 'manual',
  source_ref    text,

  severity   alert_severity NOT NULL DEFAULT 'medium',
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to   timestamptz,
  active     boolean NOT NULL DEFAULT true,
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- A vehicle entry needs a plate; a person entry needs a reference. Enforced, because a watchlist
  -- row that matches nothing is worse than no row: it looks like coverage and provides none.
  CONSTRAINT watchlist_entries_entity_ck CHECK (
    (entity_type = 'vehicle' AND plate_normalized IS NOT NULL)
    OR (entity_type = 'person' AND person_ref IS NOT NULL)
  ),
  CONSTRAINT watchlist_entries_validity_ck CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX watchlist_entries_plate_idx ON watchlist_entries (plate_normalized)
  WHERE active AND plate_normalized IS NOT NULL;
CREATE INDEX watchlist_entries_plate_trgm_idx
  ON watchlist_entries USING gin (plate_normalized gin_trgm_ops);
CREATE INDEX watchlist_entries_category_idx ON watchlist_entries (category) WHERE active;
CREATE INDEX watchlist_entries_source_idx ON watchlist_entries (source_system);

CREATE TABLE alerts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_entry_id uuid NOT NULL REFERENCES watchlist_entries (id) ON DELETE CASCADE,
  -- No FK: sightings is a hypertable. See the note in 0005.
  sighting_id uuid NOT NULL,
  sighting_ts timestamptz NOT NULL,
  camera_id   uuid NOT NULL REFERENCES cameras (id) ON DELETE CASCADE,
  ts          timestamptz NOT NULL,

  match_type     match_type NOT NULL,
  -- Edit distance under the confusion-aware metric. 0 for an exact match.
  match_distance integer NOT NULL DEFAULT 0 CHECK (match_distance >= 0),
  confidence     numeric(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  severity       alert_severity NOT NULL,

  -- The "why" payload: an operator must verify an alert in three seconds (D2-07), which means the
  -- alert carries its own evidence and reasoning rather than a bare score.
  reason jsonb NOT NULL DEFAULT '{}'::jsonb,

  dedupe_key text NOT NULL,
  -- Truncated window start. The same vehicle passing the same camera repeatedly inside one window
  -- is one alert, not fifty — a control room that gets fifty stops reading them.
  dedupe_window_start timestamptz NOT NULL,

  status   alert_status NOT NULL DEFAULT 'new',
  acked_by uuid REFERENCES users (id) ON DELETE SET NULL,
  acked_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT alerts_ack_ck CHECK (
    (status = 'new' AND acked_by IS NULL AND acked_at IS NULL) OR status <> 'new'
  )
);

-- The dedupe guarantee, enforced by the database rather than by hopeful application code.
CREATE UNIQUE INDEX alerts_dedupe_uidx ON alerts (dedupe_key, dedupe_window_start);

CREATE INDEX alerts_status_ts_idx ON alerts (status, ts DESC);
CREATE INDEX alerts_camera_ts_idx ON alerts (camera_id, ts DESC);
CREATE INDEX alerts_severity_idx ON alerts (severity) WHERE status = 'new';
CREATE INDEX alerts_watchlist_entry_idx ON alerts (watchlist_entry_id);
