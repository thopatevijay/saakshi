-- Deliberately does not drop postgis/timescaledb/pg_trgm.
--
-- On the compose stack `db/init/00-extensions.sql` created them before any migration ran, so
-- dropping them here would take the database further back than migration 0001 put it — and
-- DROP EXTENSION postgis CASCADE silently destroys every geography column in the database.
-- Rolling 0001 back is therefore a no-op by design.

SELECT 1;
