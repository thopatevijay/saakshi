-- 0005 · Plate reads and vehicle identity linking.
--
-- NOTE ON THE MISSING FOREIGN KEYS: `sightings` is a hypertable, and PostgreSQL cannot declare a
-- foreign key referencing one (its primary key is the composite (id, ts), and Timescale does not
-- support being the target of a REFERENCES clause). So every table that points at a sighting
-- carries `sighting_id` **plus** `sighting_ts`, unenforced by the database:
--   * the ts is what lets the planner exclude chunks — without it, a lookup by id alone scans
--     every daily chunk in the hypertable;
--   * referential integrity is the writer's responsibility. Both writers are ours (the analytics
--     worker, D1-09, and the alert engine, D2-06).
-- This is a deliberate deviation from PROJECT.md §8's column lists, logged to BL-01.

CREATE TABLE plate_reads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sighting_id uuid NOT NULL,
  sighting_ts timestamptz NOT NULL,

  raw_text text NOT NULL,
  -- NULL when the Indian-plate grammar validator (D2-03) rejected the read. A rejected read is
  -- kept, not discarded: the rejection rate per camera is a trust signal.
  normalized_text text,
  confidence      numeric(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  -- Best-shot selection and multi-frame voting (D2-01). The RLVD cameras run at 10 fps, giving
  -- roughly three frames per vehicle pass, so the vote is over very few reads.
  is_best_shot boolean NOT NULL DEFAULT false,
  vote_count   integer NOT NULL DEFAULT 1 CHECK (vote_count >= 1),

  crop_uri   text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX plate_reads_sighting_idx ON plate_reads (sighting_id, sighting_ts);
CREATE INDEX plate_reads_normalized_exact_idx ON plate_reads (normalized_text);

-- The single highest-leverage index in the system: confusion-aware fuzzy plate search (D2-04).
-- GIN + gin_trgm_ops supports `normalized_text % $1` and similarity() ordering; levenshtein() from
-- fuzzystrmatch then re-ranks the candidate set.
CREATE INDEX plate_reads_normalized_trgm_idx
  ON plate_reads USING gin (normalized_text gin_trgm_ops);

CREATE TABLE vehicle_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The normalised plate this identity is keyed on. Unique: one identity per plate.
  canonical_plate text NOT NULL UNIQUE,
  first_seen      timestamptz NOT NULL,
  last_seen       timestamptz NOT NULL,
  sighting_count  integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vehicle_identities_last_seen_idx ON vehicle_identities (last_seen DESC);
CREATE INDEX vehicle_identities_canonical_trgm_idx
  ON vehicle_identities USING gin (canonical_plate gin_trgm_ops);

CREATE TABLE identity_sightings (
  identity_id uuid NOT NULL REFERENCES vehicle_identities (id) ON DELETE CASCADE,
  sighting_id uuid NOT NULL,
  sighting_ts timestamptz NOT NULL,

  -- How this sighting was attached to this identity. `reid_bridge` (D3-03) links an unreadable
  -- plate by vehicle appearance and must always be visually distinct in the UI from a plate match:
  -- it is a weaker claim.
  link_method     link_method NOT NULL,
  link_confidence numeric(4, 3) NOT NULL CHECK (link_confidence >= 0 AND link_confidence <= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (identity_id, sighting_id)
);

CREATE INDEX identity_sightings_sighting_idx ON identity_sightings (sighting_id, sighting_ts);
CREATE INDEX identity_sightings_method_idx ON identity_sightings (link_method);
