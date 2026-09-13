#!/bin/bash
# Make a Railway volume usable as PGDATA for timescale/timescaledb-ha:pg16.
#
# ## What this has to work around
#
# 1. **The image runs as `postgres` (uid 1000) from PID 1 and has no root phase.** The official
#    postgres image starts its entrypoint as root, prepares the data directory and drops privileges
#    with gosu; this one never gets that chance.
#
# 2. **Railway chowns a volume to the container user only when it first provisions it.** After that
#    the volume keeps whatever ownership it has — and anything that changes the mount path leaves it
#    owned by `root:root`. Measured over five deploys, at both `/home/postgres/pgdata` and
#    `/home/postgres/pgdata/data`: `dir_owner=0 writable=n`, unchanged after 150 s. The base image's
#    own `Waiting for permissions … (0:0 -> 1000:1000)` loop gives up and proceeds regardless, so
#    the real cause surfaces as a confusing `initdb` error rather than as a permission error.
#    `RAILWAY_RUN_UID=0` does not fix it: with that variable set the process still reported uid 1000.
#
# 3. **ext4 puts `lost+found` in the root of every volume, and `initdb` refuses a non-empty
#    directory** — so even with correct ownership, the mount point cannot be used as PGDATA as-is:
#
#        initdb: error: directory "/home/postgres/pgdata/data" exists but is not empty
#        initdb: detail: It contains a lost+found directory, perhaps due to it being a mount point.
#
# ## The approach
#
# `USER root` in the Dockerfile gives this script the root phase the base image lacks. It waits for
# the volume to actually be mounted, takes ownership of it, removes the one entry initdb objects to,
# and then hands over to the base image's own entrypoint as `postgres` via gosu — the same sequence
# the official postgres image performs. **Postgres itself never runs as root**; only these few lines
# do, and `exec gosu postgres` is the last thing that happens.
set -uo pipefail
# Deliberately NOT `set -e`: this is a poll loop whose normal state is "not ready yet", so most
# iterations run a command that exits non-zero. Under `set -e`, `[ -f X ] && return 0` is a complete
# statement whose non-zero status kills the shell on the first miss, silently. Every condition below
# is a full `if`.

DATA="${PGDATA:-/home/postgres/pgdata/data}"
PG_UID=1000
PG_GID=1000

echo "saakshi: entrypoint starting - PGDATA=$DATA uid=$(id -u)"

if [ "$(id -u)" != '0' ]; then
  # A local `docker run` that overrides the user, for instance. Nothing can be prepared from here,
  # and pretending otherwise would hide the reason for a later failure.
  echo "saakshi: not root (uid $(id -u)) - skipping volume preparation"
  exec /docker-entrypoint.sh "$@"
fi

# When this script starts, $DATA is still the image's own empty directory; Railway mounts the volume
# over it a moment later. `lost+found` appearing is the unambiguous signal that the real filesystem
# is underneath. An existing cluster is the other terminal state, and needs nothing.
deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
  if [ -f "$DATA/PG_VERSION" ]; then break; fi
  if [ -d "$DATA/lost+found" ]; then break; fi
  sleep 1
done

mkdir -p "$DATA"

if [ ! -f "$DATA/PG_VERSION" ] && [ -d "$DATA/lost+found" ]; then
  echo "saakshi: clearing lost+found from an empty PGDATA so initdb will accept it"
  rm -rf "$DATA/lost+found"
fi

# Scoped to the volume: a recursive chown of $PGROOT would rewrite the image's own files for no
# reason. initdb also insists on 0700.
chown -R "$PG_UID:$PG_GID" "$DATA"
chmod 0700 "$DATA"
echo "saakshi: PGDATA prepared (owner $(stat -c %u:%g "$DATA"), mode $(stat -c %a "$DATA")) - dropping to postgres"

exec gosu postgres /docker-entrypoint.sh "$@"
