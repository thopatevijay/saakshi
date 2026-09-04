-- 0007 · Route reconstruction. Observed hops vs inferred path on the road graph (D3-01),
-- and impossible-transition detection (D3-02).

CREATE TABLE routes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id  uuid NOT NULL REFERENCES vehicle_identities (id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  params       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX routes_identity_idx ON routes (identity_id);
CREATE INDEX routes_requested_at_idx ON routes (requested_at DESC);

CREATE TABLE route_segments (
  route_id uuid NOT NULL REFERENCES routes (id) ON DELETE CASCADE,
  seq      integer NOT NULL,

  -- No FK: sightings is a hypertable. See the note in 0005.
  from_sighting_id uuid NOT NULL,
  from_sighting_ts timestamptz NOT NULL,
  to_sighting_id   uuid NOT NULL,
  to_sighting_ts   timestamptz NOT NULL,

  -- TRUE  = both endpoints were actually seen on camera.
  -- FALSE = the vehicle was seen at both ends and the path between them is OSRM's inference.
  -- The UI must render the two differently: one is evidence, the other is a plausible guess, and
  -- conflating them in a police tool is the failure mode worth designing against.
  observed bool NOT NULL,

  path                geography(LineString, 4326),
  travel_time_s        integer CHECK (travel_time_s IS NULL OR travel_time_s >= 0),
  inferred_confidence numeric(4, 3)
    CHECK (inferred_confidence IS NULL OR (inferred_confidence >= 0 AND inferred_confidence <= 1)),

  -- 'impossible_transition' = the implied speed between two sightings exceeds what the road graph
  -- allows, which means either a cloned plate or an OCR error. Both are findings worth surfacing.
  anomaly route_anomaly NOT NULL DEFAULT 'none',

  PRIMARY KEY (route_id, seq)
);

CREATE INDEX route_segments_path_gix ON route_segments USING gist (path);
CREATE INDEX route_segments_anomaly_idx ON route_segments (anomaly) WHERE anomaly <> 'none';
