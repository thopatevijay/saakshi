-- 0015 · The natural key a watchlist entry already has (D2-05).
--
-- `watchlist_entries` (0006) has no key other than its generated `id`, which makes every ingest path
-- into it append-only by accident: run `seed:watchlist` twice and the estate has 400 rows claiming
-- 200 vehicles, and re-importing a corrected CSV row adds a second, contradicting entry rather than
-- replacing the first. Both are silent — the counts look plausible and the lookup returns two hits
-- where it should return one.
--
-- Every real source of these rows already carries an identifier: VAHAN's registration record, a
-- SARTHI DL number, an eGujCop FIR reference, an AFIS/NAFIS subject reference, or the case number a
-- desk officer typed. `source_ref` is that identifier and `source_system` is the namespace it lives
-- in, so `(source_system, source_ref)` is the key the data has in the world. Declaring it lets the
-- seeder and the bulk importer `ON CONFLICT … DO UPDATE`, which is what makes a re-import a
-- correction instead of a duplication.
--
-- Partial on `source_ref IS NOT NULL` because a manually-entered entry need not carry one: an
-- officer adding a plate from a radio call has no reference to type, and forcing an invented one
-- would be worse than allowing the row to be keyed only by its id.
CREATE UNIQUE INDEX watchlist_entries_source_uidx
  ON watchlist_entries (source_system, source_ref)
  WHERE source_ref IS NOT NULL;
