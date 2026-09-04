-- 0012 · Catalogue ingest (D1-04): presence tracking, local notes, and the sync report.
--
-- The organisers are explicit that `GET /api/ingest` is the contract and the URL pattern is not.
-- The camera set can change between now and evaluation day, so the registry has to be re-syncable
-- at any moment — including live on stage — without duplicating, without deleting, and without
-- losing anything a human typed in.

-- ── 1 · Presence is not health ──────────────────────────────────────────────────────────────────
-- D1-04's AC asks for `status='absent'` flipping back to `'active'`. Neither value exists in
-- `camera_status`, which is ('unknown','online','degraded','offline') — and that column is the
-- prober's (D1-05): 0003 documents it as measured, and D1-02's importer deliberately keeps it out
-- of every update set so "a metadata re-import must never silently reset a measurement".
--
-- Presence in the upstream catalogue and health of the stream are genuinely different facts. A
-- camera can be listed and dead, or delisted and still serving. Folding them into one column would
-- have ingest overwrite the prober's measurement, and a returning camera set to 'active' would be
-- overwritten by the prober's next sweep anyway. So presence gets its own dimension.
CREATE TYPE catalogue_status AS ENUM ('active', 'absent');

ALTER TABLE cameras
  ADD COLUMN catalogue_status catalogue_status NOT NULL DEFAULT 'active',
  -- Last run in which the upstream catalogue actually listed this camera. NULL = never seen in a
  -- catalogue, i.e. onboarded by hand or by bulk import rather than by sync.
  ADD COLUMN catalogue_last_seen_at timestamptz,
  -- When it went missing. Together with last_seen this answers "how long has this been gone",
  -- which is the question that decides whether a delisting is a glitch or a decommissioning.
  ADD COLUMN catalogue_absent_since timestamptz,
  -- Local, human-entered. Named by D1-04 as an enrichment field that must survive re-sync; there
  -- was nowhere to put it. Sync never writes this column.
  ADD COLUMN notes text;

-- The registry map (D1-08) and the prober (D1-05) both want "everything currently listed", and the
-- gap analysis (D3-06) wants the complement. Partial on the live rows, as every read path filters
-- soft-deleted ones out.
CREATE INDEX cameras_catalogue_status_idx
  ON cameras (catalogue_status)
  WHERE deleted_at IS NULL;

-- ── 2 · The sync report ─────────────────────────────────────────────────────────────────────────
-- "Emit a sync report: added / updated / went-absent / returned / unchanged", persisted and
-- readable over the API. It is also the forensic record: when the camera set changes under us on
-- evaluation day, this table is what says when, and to what.
CREATE TABLE catalogue_sync_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Where it was pulled from. Recorded per run because the URL is configuration, so a run from a
  -- different endpoint must be distinguishable after the fact.
  source      text NOT NULL,
  -- Scope of the run. Absence is computed within one department only: a camera owned by another
  -- department is not "missing" from this catalogue, and marking it absent would be a lie.
  department_id uuid REFERENCES departments (id) ON DELETE SET NULL,

  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,

  ok          boolean NOT NULL,
  -- Which tolerant-parse strategy matched, e.g. 'array' or 'wrapped:cameras'. Records what the
  -- upstream payload actually looked like on the day, without needing the payload itself.
  shape       text,
  trigger_source text NOT NULL,       -- 'cli' | 'api' | 'schedule'

  fetched     integer NOT NULL DEFAULT 0,
  added       integer NOT NULL DEFAULT 0,
  updated     integer NOT NULL DEFAULT 0,
  unchanged   integer NOT NULL DEFAULT 0,
  went_absent integer NOT NULL DEFAULT 0,
  returned    integer NOT NULL DEFAULT 0,
  rejected    integer NOT NULL DEFAULT 0,

  error       text,
  -- The AC: "Unknown payload shape produces a clear error with the raw JSON persisted for
  -- inspection." Kept only on a failed run — on success it is a duplicate of the registry, and
  -- retaining upstream payloads indefinitely is data we have no reason to hold.
  raw_payload jsonb,
  -- Per-entry rejections, [{row, externalId, errors:[{field,message}]}] — the same shape D1-02's
  -- bulk importer reports, so one UI renders both.
  rejections  jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- Keyset pagination on (started_at desc, id desc): the report list is always "most recent first".
-- D1-02 measured what happens without this index — a Parallel Seq Scan over the whole table plus a
-- top-N sort, on every page request — so it ships in the same migration as the endpoint.
CREATE INDEX catalogue_sync_runs_pagination_idx
  ON catalogue_sync_runs (started_at DESC, id DESC);

CREATE INDEX catalogue_sync_runs_department_idx ON catalogue_sync_runs (department_id);
