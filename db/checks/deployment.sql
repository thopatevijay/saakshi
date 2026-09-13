-- Deployment verification for the hosted database (D4-01).
--
-- Exists as a FILE rather than as a `psql -c "…"` in a runbook because `railway ssh` re-joins its
-- arguments through a remote shell without quoting them: any argument containing a space or a
-- parenthesis is mangled (`sh: 1: Syntax error: "(" unexpected`), so `-c "select postgis_version();"`
-- cannot be run that way at all. `psql -f` takes a path, which has neither problem.
--
--   railway ssh --service api psql "$DATABASE_URL" -f /app/db/checks/deployment.sql
--
-- It answers, in order: are both mandatory extensions present, is the schema migrated, and does the
-- registry hold anything. Those are three of D4-01's acceptance criteria and the first thing to run
-- after any redeploy or restore.

\echo '== extensions: PostGIS and TimescaleDB are both mandatory =='
select extname, extversion
from pg_extension
where extname in ('postgis', 'timescaledb', 'pg_trgm', 'fuzzystrmatch', 'pgcrypto')
order by extname;

\echo ''
\echo '== PostGIS full version string =='
select postgis_version() as postgis_version;

\echo ''
\echo '== TimescaleDB hypertables (D1-01 created these; an empty result means the extension is inert) =='
select hypertable_name
from timescaledb_information.hypertables
order by hypertable_name;

\echo ''
\echo '== schema migrations applied =='
select count(*) as migrations_applied from schema_migrations;

\echo ''
\echo '== registry contents =='
select
  (select count(*) from cameras)     as cameras,
  (select count(*) from departments) as departments,
  (select count(*) from users)       as users;

\echo ''
\echo '== TLS on this very connection (D4-01 AC 8: local workers must reach the cloud over TLS) =='
select s.ssl, s.version, s.cipher
from pg_stat_ssl s
where s.pid = pg_backend_pid();
