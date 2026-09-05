-- 0017 · What route reconstruction needs that 0007 could not yet know (D3-01).
--
-- 0007 gave `routes`/`route_segments` the right skeleton: an identity, an ordered pair of sightings
-- per segment, an `observed` boolean, a path, a travel time and a confidence. Three things it could
-- not have known, because they only became facts once the road graph and the trace API existed:
--
-- 1 · **A route is a cache, and a cache needs a key and an invalidation rule.** The ticket asks for
--     "cache by (identity, window, params)" and "cache invalidated when new sightings arrive".
--     Those are two different keys and both are needed. `cache_key` is the *question* — the plate,
--     the window, the confidence floor, the distance ceiling, the camera filter and the version of
--     the scoring model. `sightings_fingerprint` is the *evidence* — a hash of the ordered
--     `(sighting_id, ts)` list the trace returned. A repeat of the same question against the same
--     evidence is a hit; the moment a sighting is written the fingerprint changes and the same
--     question is a miss. Keying on `requested_at` or a TTL instead would serve a stale route for
--     however long the TTL was, which in an investigation is the wrong failure.
--
-- 2 · **A segment has four shapes, not two.** `observed` (a bool) says whether the *movement* was
--     witnessed, and that stays the headline claim. But "not witnessed" splits into three cases an
--     operator must be able to tell apart, and collapsing them is exactly the blurring this ticket
--     exists to prevent:
--       · `inferred_path`       — two placed cameras and OSRM found a road path. Scoreable.
--       · `inferred_revisit`    — the same camera in a *different* tracking session. The vehicle
--                                 left and came back; where it went is not merely unwitnessed, it
--                                 is unbounded. No distance may be claimed, not even zero.
--       · `inferred_unroutable` — a camera has no coordinates (the normal case on this estate:
--                                 0 of 30 real cameras are placed) or the graph has no path.
--     `observed_dwell` is the fourth: the same camera *and* the same tracking session and raw
--     tracker id, so ByteTrack held the vehicle continuously between the two frames and nothing
--     between them is inferred at all.
--
-- 3 · **A confidence nobody can take apart is a number nobody should trust.** `inferred_confidence`
--     is the product of three factors; `confidence_basis` stores them individually so the UI can
--     say *why* a segment scored 0.03 rather than only that it did. docs/route-reconstruction.md
--     is the formula; this column is the working.
--
-- Note on distance columns: `road_distance_m` is the OSRM path length and `straight_line_m` is the
-- great-circle chord. **Both are lower bounds on the distance actually driven** — OSRM returns the
-- fastest path, not the path taken. Keep them separate: the ratio between them is itself a signal
-- (a road distance far above the chord means the two cameras are poorly connected), and D3-06 wants
-- it.

ALTER TABLE routes
  -- The question. `null` on a route built before this migration; nothing serves such a row.
  ADD COLUMN cache_key             text,
  -- The evidence. sha256 over the ordered `(sighting_id, ts)` list, hex.
  ADD COLUMN sightings_fingerprint text,
  ADD COLUMN sighting_count        integer NOT NULL DEFAULT 0,
  ADD COLUMN built_at              timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN build_ms              integer,
  -- The summary as served: totals, the observed/inferred kilometre split, the camera count. Stored
  -- rather than recomputed on read so a cache hit is a single round trip.
  ADD COLUMN summary               jsonb NOT NULL DEFAULT '{}'::jsonb;

-- One row per question. A rebuild replaces it, so the table cannot grow a row per request.
CREATE UNIQUE INDEX routes_cache_key_uidx ON routes (cache_key) WHERE cache_key IS NOT NULL;

ALTER TABLE route_segments
  -- Denormalised from the sightings deliberately: `sightings` is a hypertable and a cache hit must
  -- not have to join it to render a segment's endpoints.
  ADD COLUMN from_camera_id      uuid,
  ADD COLUMN to_camera_id        uuid,

  ADD COLUMN kind text NOT NULL DEFAULT 'inferred_path'
    CHECK (kind IN ('observed_dwell', 'inferred_path', 'inferred_revisit', 'inferred_unroutable')),

  -- Observed gap between the two sightings, from PTS-derived wall clock. Never arrival time.
  ADD COLUMN elapsed_s        integer CHECK (elapsed_s IS NULL OR elapsed_s >= 0),
  -- OSRM path length. A LOWER bound on the distance driven: OSRM returns the fastest path.
  ADD COLUMN road_distance_m  integer CHECK (road_distance_m IS NULL OR road_distance_m >= 0),
  -- Great-circle chord between the two cameras. The weaker lower bound, carried from D2-08.
  ADD COLUMN straight_line_m  integer CHECK (straight_line_m IS NULL OR straight_line_m >= 0),
  -- How many *plausible* alternative paths OSRM offered. 1 means the route is essentially forced;
  -- more means the vehicle had a real choice and the drawn line is one of several equal stories.
  ADD COLUMN path_options     integer CHECK (path_options IS NULL OR path_options >= 0),
  -- {"timing": .., "uniqueness": .., "endpoints": ..} — the three factors, before multiplication.
  ADD COLUMN confidence_basis jsonb,
  -- Plain language, rendered as-is. Every segment says what it is claiming and what it is not.
  ADD COLUMN note             text;

CREATE INDEX route_segments_kind_idx ON route_segments (kind);
