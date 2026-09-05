-- 0014 · Vehicle attributes and evidence store (D2-02).
--
-- `sightings` already carries `vehicle_color`, `vehicle_type` and `crop_uri` from 0004; D1-09
-- deliberately left all three NULL because the analytics skeleton had nothing honest to put in
-- them. This migration adds the three columns that make the attribute *honest* rather than merely
-- present, and the flag that makes "we store a crop only for a best shot" a queryable property
-- instead of a claim in a README.

ALTER TABLE sightings
  -- Share of the vehicle box's interior pixels that voted for the winning palette entry, 0-1.
  --
  -- Emitted always, even when the read is confident, because the number is what lets a query say
  -- "white, probably" versus "white". A colour with no confidence beside it is a guess wearing a
  -- fact's clothes.
  ADD COLUMN vehicle_color_confidence numeric(4, 3)
    CHECK (vehicle_color_confidence IS NULL
           OR (vehicle_color_confidence >= 0 AND vehicle_color_confidence <= 1)),

  -- TRUE when the classifier could not separate the top two palette entries well enough to name
  -- one. `vehicle_color` is then `'unknown'` — never the runner-up quietly promoted. The rate of
  -- this flag is a measurement in its own right: it is how badly the estate's night frames and
  -- oblique angles hurt, and it belongs in the report rather than being hidden by a lower threshold.
  ADD COLUMN attributes_low_confidence boolean,

  -- The one sighting per track *session* chosen to represent the vehicle.
  --
  -- Not per track id per camera: D1-09 measured raw ByteTrack ids 1 and 2 being reused across
  -- sessions 6 and 9 on cam03 inside a single run, so `track_id` alone is not a vehicle. The stored
  -- `track_id` is already session-qualified (`session * 100_000 + tracker_id`), which is what makes
  -- one best shot per (camera_id, track_id) mean one best shot per vehicle-appearance.
  --
  -- NOT NULL DEFAULT false: "no best shot chosen yet" and "not the best shot" are the same fact for
  -- every consumer, and a nullable boolean here would make every count query three-valued.
  ADD COLUMN is_best_shot boolean NOT NULL DEFAULT false;

-- The evidence queries — "the crops for this camera today", "how many objects should the bucket
-- hold" — all filter to best shots, which are ~1 in 100 of the table. Partial, so the index carries
-- only the rows those queries can return.
CREATE INDEX sightings_best_shot_idx
  ON sightings (camera_id, ts DESC)
  WHERE is_best_shot;
