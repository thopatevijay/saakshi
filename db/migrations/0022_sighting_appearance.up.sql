-- 0022 · Vehicle appearance embeddings (D3-03).
--
-- One row per best-shot vehicle crop: the appearance descriptor that lets a trace bridge a sighting
-- whose plate was unreadable to an identity whose plate was read.
--
-- ## This is not biometric data, and the distinction is load-bearing
--
-- SAAKSHI performs **no face recognition** and stores no biometric template — deliberately, because
-- it is not mandated by the challenge and would need separate legal authorisation (`CLAUDE.md`,
-- claims discipline). What this table stores describes the *outside of a vehicle*: white-balanced
-- colour histograms over four horizontal stripes of the crop, plus a coarse edge-orientation
-- signature. It cannot identify a person and the crop it came from was never examined for one.
--
-- A reader who sees "embedding" and assumes "face" would be wrong, so `docs/reid.md` §2 says so in
-- those words and this comment is the second place it is said.
--
-- ## Why a separate table and not a column on `sightings`
--
-- Three reasons, in order of how much they would hurt:
--
-- 1. `sightings` is a TimescaleDB hypertable carrying roughly one row per detection per inferred
--    frame — 33,548 rows from one camera in a 22-minute soak. An embedding exists for one row per
--    *track session* (D2-02's best shot), which is a 500:1 difference. A nullable `real[]` on the
--    hot table would be paid for by every row that will never have one.
-- 2. A descriptor change is a new `embedder_id`, and re-embedding a corpus means rewriting this
--    table, not rewriting the sightings hypertable.
-- 3. `DELETE FROM sighting_appearance` is how the feature is switched off at the data layer. It
--    must not be a schema change on the table the whole product reads.
--
-- ## The (sighting_id, sighting_ts) pattern is not optional
--
-- Nothing can declare a foreign key to a hypertable, so — exactly as `identity_sightings` (0005)
-- and `plate_reads` do — the reference is `sighting_id` **plus** `sighting_ts`, unenforced, with
-- the ts present so the planner can exclude chunks on the join. Dropping the ts would turn every
-- gallery build into a full scan of every chunk.

CREATE TABLE sighting_appearance (
  sighting_id uuid NOT NULL,
  sighting_ts timestamptz NOT NULL,

  -- Denormalised from `sightings` so a gallery build and the spatio-temporal gate can read camera
  -- and time without touching the hypertable at all. Both are immutable for a given sighting.
  camera_id uuid NOT NULL REFERENCES cameras (id) ON DELETE CASCADE,

  -- Which descriptor produced this vector. Two embeddings may be compared ONLY when their ids
  -- match: a cosine between `sog-hsv-shape-v1` and some future `resnet-ibn-a` is a number with no
  -- meaning, and it would be a number that silently links two unrelated vehicles. The bridge
  -- filters on this column and `reid.test.ts` proves it.
  embedder_id text NOT NULL,
  dim         integer NOT NULL CHECK (dim > 0 AND dim <= 4096),

  -- L2-normalised float32, stored as `real[]`. Not `vector` (pgvector is not in this stack) and not
  -- `bytea`: `real[]` is readable in psql, which matters when the question is "why did these two
  -- link", and the galleries here are tens of vectors, not millions.
  embedding real[] NOT NULL,

  -- The best-shot score of the crop this came from, copied at write time. D2-08 found that the
  -- shipped "plate" crops include Gujarati shop signage — the detector fires on high-contrast
  -- rectangular text of any kind. An appearance bridge matched on such crops would happily link two
  -- shop signs to each other, so the bridge applies a floor on this column rather than trusting the
  -- detector's own confidence.
  best_shot_score numeric(4, 3) NOT NULL
    CHECK (best_shot_score >= 0 AND best_shot_score <= 1),

  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (sighting_id, embedder_id)
);

-- The gallery build and the candidate sweep are both "this camera, this window", which is exactly
-- this index. `embedder_id` trails so that one index serves both the current descriptor and a
-- re-embedding run alongside it.
CREATE INDEX sighting_appearance_camera_ts_idx
  ON sighting_appearance (camera_id, sighting_ts DESC, embedder_id);

CREATE INDEX sighting_appearance_ts_idx ON sighting_appearance (sighting_ts DESC);

COMMENT ON TABLE sighting_appearance IS
  'Vehicle appearance descriptors for best-shot crops (D3-03). Not biometric: no faces, no people. '
  'Held-out precision measured at 0.761 on fixtures/reid-eval, below the 0.9 bar, so the bridge '
  'that consumes this table ships disabled by default (REID_ENABLED). See docs/reid.md.';
