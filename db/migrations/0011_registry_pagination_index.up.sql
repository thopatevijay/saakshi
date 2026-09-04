-- 0011 · The index keyset pagination actually needs.
--
-- Found by EXPLAIN at 100k rows during D1-02's benchmark, not by guessing. The list endpoint orders
-- by (onboarded_at, id) so pages are stable and a cursor is flat regardless of depth — but with no
-- index on that ordering, Postgres was doing:
--
--   Limit
--     -> Gather Merge
--       -> Sort  (Sort Key: onboarded_at, id · top-N heapsort)
--         -> Hash Left Join
--           -> Parallel Seq Scan on cameras  (actual rows=50000 loops=2)   <-- all 100,000 rows
--
-- ...to return fifty. Keyset pagination without a matching index is just OFFSET with extra steps:
-- the sort is O(n) in table size on every single page request.
--
-- Partial on `deleted_at IS NULL` because every read path filters soft-deleted rows out, so the
-- index only carries the rows queries can actually return.
CREATE INDEX cameras_pagination_idx
  ON cameras (onboarded_at, id)
  WHERE deleted_at IS NULL;
