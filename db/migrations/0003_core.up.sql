-- 0003 · Core registry: departments, users, cameras, coverage, road network.
-- PROJECT.md §8. Pillar 1 lives here: a registry that tells the truth about what exists.

CREATE TABLE departments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  code         text NOT NULL UNIQUE,
  contact_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  badge_no      text NOT NULL UNIQUE,
  role          user_role NOT NULL,
  department_id uuid REFERENCES departments (id) ON DELETE SET NULL,
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_department_idx ON users (department_id);

CREATE TABLE cameras (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The id the owning department knows the camera by (e.g. the sandbox's `cam09`). Unique because
  -- catalogue ingest (D1-04) upserts on it.
  external_id   text NOT NULL UNIQUE,
  name          text NOT NULL,
  department_id uuid REFERENCES departments (id) ON DELETE SET NULL,

  location      geography(Point, 4326),
  address       text,
  district      text,

  camera_type   camera_type NOT NULL DEFAULT 'ip',
  mount         camera_mount NOT NULL DEFAULT 'static',
  geometry_class camera_geometry NOT NULL DEFAULT 'unclassified',

  -- DECLARED, never trusted. The sandbox catalogue declares only {id,name}; where a department does
  -- declare codec/fps/resolution it is frequently wrong. The declared-vs-measured delta is the
  -- product feature — measured values live in camera_health_checks.
  declared_codec      text,
  declared_fps        numeric(6, 2),
  declared_resolution text,

  vendor         text,
  vms_platform   text,
  retention_days integer CHECK (retention_days IS NULL OR retention_days >= 0),
  storage_type   storage_type,

  adapter_kind adapter_kind NOT NULL,
  -- Adapter-specific, e.g. {"hls": "https://host/cam09/index.m3u8"}. Never a hardcoded pattern:
  -- GET /api/ingest is the contract, the URL shape is not.
  endpoints    jsonb NOT NULL DEFAULT '{}'::jsonb,

  status      camera_status NOT NULL DEFAULT 'unknown',
  -- 0-100, computed by D1-06. NULL until the prober has run at least once — an unprobed camera is
  -- not a zero-trust camera, it is an unknown one, and the UI must show the difference.
  trust_score numeric(5, 2) CHECK (trust_score IS NULL OR (trust_score >= 0 AND trust_score <= 100)),

  onboarded_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cameras_location_gix ON cameras USING gist (location);
CREATE INDEX cameras_department_idx ON cameras (department_id);
CREATE INDEX cameras_district_idx ON cameras (district);
CREATE INDEX cameras_status_idx ON cameras (status);
CREATE INDEX cameras_geometry_class_idx ON cameras (geometry_class);

CREATE TABLE camera_coverage (
  camera_id        uuid PRIMARY KEY REFERENCES cameras (id) ON DELETE CASCADE,
  fov_polygon      geography(Polygon, 4326),
  covered_road_ids bigint[] NOT NULL DEFAULT '{}',
  computed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX camera_coverage_fov_gix ON camera_coverage USING gist (fov_polygon);

-- OSM import target. The data import itself is D3-01; this migration creates the table only.
CREATE TABLE road_network (
  id           bigint PRIMARY KEY,
  geom         geography(LineString, 4326) NOT NULL,
  name         text,
  highway_class text
);

CREATE INDEX road_network_geom_gix ON road_network USING gist (geom);
CREATE INDEX road_network_highway_class_idx ON road_network (highway_class);
