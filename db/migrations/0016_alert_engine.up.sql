-- 0016 · What the alert engine needs that 0006 could not yet know (D2-06).
--
-- Four changes, each forced by a measurement taken after 0006 was written.
--
-- 1 · `match_distance` was `integer`. D2-04's confusion-aware metric is **continuous**:
--     `GJ35U07 → GJ35U0779` is 0.70 and `GJ32DD10 → GJ32D0107` is 0.55, both measured today against
--     the 235-entry watchlist. Under an integer column those become 1 and 1 — two very different
--     matches rendered identical, and the distance an officer is shown stops being the distance the
--     matcher computed. numeric(6,3) keeps three decimals, which is more than the metric's own
--     resolution (costs are quantised at 0.05).
--
-- 2 · Dedupe has to be able to *update*. The acceptance criterion is that the same vehicle at the
--     same camera twenty times in five minutes is ONE alert "with an updated last-seen and a
--     sighting count" — 0006 gave the table the unique index that collapses the repeats but nowhere
--     to record that they happened. Without `sighting_count` a collapsed alert is indistinguishable
--     from a single sighting, which throws away the one signal that says this vehicle is loitering.
--
-- 3 · Lifecycle needs an actor and a timestamp for EVERY transition, not only for ack. 0006 has
--     `acked_by`/`acked_at`; a dismissal and an escalation are exactly as consequential and were
--     unrecorded. They are kept separate rather than reused: "who acknowledged this" and "who last
--     changed its state" are different questions, and an escalation after an ack must not erase the
--     name of the officer who acknowledged it.
--
-- 4 · `alert_digests`. The rate limiter caps how many alerts reach the operator's queue per minute.
--     Overflow that is merely dropped is the failure this whole ticket exists to prevent, so the
--     suppressed alerts are aggregated into a durable row per window. The alert rows themselves are
--     ALWAYS written — what is capped is delivery, never persistence.

ALTER TABLE alerts
  ALTER COLUMN match_distance TYPE numeric(6, 3) USING match_distance::numeric(6, 3);

ALTER TABLE alerts
  -- The most recent sighting folded into this alert. `ts` stays the FIRST sighting, so the pair
  -- answers "when did this start" and "is it still happening" without a second query.
  ADD COLUMN last_seen_at        timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_sighting_id    uuid,
  ADD COLUMN last_sighting_ts    timestamptz,
  -- Sightings collapsed into this alert, including the first. Never 0.
  ADD COLUMN sighting_count      integer NOT NULL DEFAULT 1 CHECK (sighting_count >= 1),
  -- The observed plate that produced the most recent sighting on this alert. A re-sighting can be a
  -- different OCR string matching the same entry, and hiding that would make the count a lie.
  ADD COLUMN last_observed_plate text,
  ADD COLUMN status_changed_at   timestamptz,
  ADD COLUMN status_changed_by   uuid REFERENCES users (id) ON DELETE SET NULL;

-- The control room's default sort: newest activity first, not oldest creation first. A vehicle seen
-- again five minutes ago matters more than one first seen an hour ago.
CREATE INDEX alerts_last_seen_idx ON alerts (last_seen_at DESC);
-- The sliding-window dedupe probe: "is there already an open alert for this key, recently?"
CREATE INDEX alerts_dedupe_key_last_seen_idx ON alerts (dedupe_key, last_seen_at DESC);

CREATE TABLE alert_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  window_start timestamptz NOT NULL,
  window_end   timestamptz NOT NULL,

  -- Alerts persisted during this window but NOT delivered live, because the per-minute cap was
  -- already spent. They are in `alerts`; this row is the operator's notice that they exist.
  suppressed_count integer NOT NULL CHECK (suppressed_count >= 0),
  -- Alerts that were delivered in the same window, so a reader can see the cap's effect without
  -- joining anything.
  delivered_count  integer NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),

  by_severity jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_category jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_camera   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A handful of suppressed alert ids, so the digest is actionable rather than only a number.
  sample      jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT alert_digests_window_ck CHECK (window_end > window_start)
);

-- One digest per window. A second flush of the same window updates the counts rather than adding a
-- second row that quietly double-counts the suppression.
CREATE UNIQUE INDEX alert_digests_window_uidx ON alert_digests (window_start);
CREATE INDEX alert_digests_created_idx ON alert_digests (created_at DESC);
