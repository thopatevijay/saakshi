# PostgreSQL 16 + PostGIS + TimescaleDB for the hosted deployment (D4-01).
#
# Railway's **managed Postgres plugin is unusable for this project**: it ships neither PostGIS nor
# TimescaleDB, and both are load-bearing — PostGIS for every `geography(Point,4326)` column in the
# registry, TimescaleDB for the `camera_health_checks` and `sightings` hypertables. The custom image
# is the only option, not a preference.
#
# This is a one-line wrapper for the same reason ops/valkey and ops/minio are: it keeps every
# service in this project deployed from the repository by the same mechanism
# (RAILWAY_DOCKERFILE_PATH), so there is no half-image / half-repo split for a future session to
# discover. The entrypoint, CMD and PGDATA all come from the base image unchanged.
FROM timescale/timescaledb-ha:pg16

# No `-c max_connections=…` override, deliberately, and the reasoning belongs next to the decision.
# docker-compose.yml raises it to 300 because a laptop runs two API instances plus both Python
# workers plus a psql session against the image default of 100. The hosted deployment runs ONE api
# replica with DATABASE_POOL_MAX=20, leaving ~80 connections for the local Topology B workers and a
# human — comfortably inside the default. Raising it here would also mean overriding the base
# image's Patroni entrypoint, which is a larger change than the problem warrants.

# The image runs as `postgres` from PID 1, so it has no root phase in which to prepare a freshly
# mounted volume — and a Railway volume arrives root-owned with an ext4 `lost+found` in it. The
# wrapper waits for the chown and clears that one entry; everything else is the base image's own
# entrypoint, unmodified. Full reasoning in the script.
# The base image sets `USER postgres`, which leaves no root phase in which to prepare a volume that
# Railway hands over as root:root. Root here is for the handful of lines in the wrapper; it execs
# `gosu postgres` before Postgres itself ever starts.
USER root
COPY ops/db/entrypoint.sh /saakshi-entrypoint.sh
ENTRYPOINT ["/saakshi-entrypoint.sh"]
CMD ["postgres"]
