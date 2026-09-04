-- 0001 · Extensions.
--
-- `db/init/00-extensions.sql` also creates these, but that only runs on a first-boot empty data
-- directory (docker-entrypoint-initdb.d). Managed Postgres — Railway, D4-01 — never runs it, so the
-- schema has to be self-sufficient. IF NOT EXISTS makes the two paths idempotent together.

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS postgis;

-- Confusion-aware fuzzy plate matching (D2-04): pg_trgm for the similarity index,
-- fuzzystrmatch for levenshtein() over the normalised plate text.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- pgcrypto: gen_random_uuid() for primary keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
