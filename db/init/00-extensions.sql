-- Data-plane extensions. Runs once, on first initialisation of an empty data directory
-- (docker-entrypoint-initdb.d). Schema itself belongs to D1-01, not here.
--
-- timescaledb is preloaded by the timescaledb-ha image; postgis ships in the same image but is
-- not created automatically. postgis_topology is not used yet but costs nothing and avoids a
-- second init pass later.

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- Deterministic, low-cost text ops used by the fuzzy plate index (D2-04).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
