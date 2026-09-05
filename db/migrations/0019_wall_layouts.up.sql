-- 0019 · The video wall's layout, persisted per **user** (D3-07).
--
-- The acceptance criterion is "Layout persists across reload per user", and the word that matters is
-- *user*. `localStorage` and a cookie both persist per **browser**: a control-room operator who
-- signs in at a different console, or on the second shift's machine, would find someone else's wall.
-- In a room where several officers share a workstation that is not a nicety — the layout is the
-- operator's working set of cameras, and handing it to whoever sits down next is wrong.
--
-- So it is keyed on the user id and it lives in the database. One row per user, replaced wholesale:
-- there is no history worth keeping and no merge worth attempting.
--
-- `layout` is jsonb rather than a slots table because the whole value is written and read as a unit
-- and never queried into. Its shape is validated by `WallLayout` in `routes/stream-contracts.ts`
-- before it is stored, so a malformed layout cannot be persisted and then crash the screen that
-- reads it back. The CHECK below is the last line of that defence at the storage layer.

CREATE TABLE IF NOT EXISTS wall_layouts (
  user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- { "grid": "3x3", "slots": [<camera uuid | null>, ...], "overlay": bool, "mode": "hls"|"whep" }
  layout      jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wall_layouts_layout_is_object CHECK (jsonb_typeof(layout) = 'object'),
  CONSTRAINT wall_layouts_layout_has_grid  CHECK (layout ? 'grid' AND layout ? 'slots'),
  CONSTRAINT wall_layouts_slots_is_array   CHECK (jsonb_typeof(layout -> 'slots') = 'array')
);

COMMENT ON TABLE wall_layouts IS
  'One video-wall layout per user (D3-07). Replaced wholesale on save; no history.';
