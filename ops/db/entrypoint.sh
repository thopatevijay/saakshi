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

# ── TLS ───────────────────────────────────────────────────────────────────────────────────────────
# Postgres ships with `ssl = off`, and Railway's TCP proxy is a **raw TCP forwarder** - it terminates
# no TLS of its own. So a database reached over that proxy with SSL off carries its credentials and
# every row of a police estate across the public internet in clear text. `sslmode=require` does not
# save you: the client asks, the server says it cannot, and the connection is refused
# (`server does not support SSL, but SSL was required`) - which is at least a loud failure, but it
# means Topology B simply cannot run until the server has a certificate.
#
# This has to happen AFTER the cluster exists: on a first boot PGDATA is empty, `postgresql.auto.conf`
# has not been written yet, and there is nothing to configure. Hence a background task that waits for
# the socket, writes the settings with ALTER SYSTEM and reloads - `ssl` is a SIGHUP parameter, so no
# restart is needed.
#
# The certificate is self-signed, and the honest consequence is stated rather than hidden: it gives
# **encryption in transit, not server authentication**. Clients therefore use `sslmode=require`, which
# encrypts without verifying the issuer. `verify-full` needs a certificate from a real CA, which is a
# production concern for a department deployment; see docs/deployment.md.
configure_tls() {
  local crt="$DATA/server.crt"
  local key="$DATA/server.key"
  local sock=""

  # NOT $PGSOCKET. The image sets PGSOCKET=/home/postgres/pgdata, but the running server actually
  # listens on /var/run/postgresql (symlinked from /run/postgresql) - verified in the container:
  #     srwxrwxrwx 1 postgres postgres 0 /var/run/postgresql/.s.PGSQL.5432
  # Trusting PGSOCKET made every psql here fail with `No such file or directory`, and because the
  # wait loop used the same wrong path it burned its full timeout before reporting. Probe instead of
  # believing a variable.
  for _ in $(seq 1 180); do
    for candidate in /var/run/postgresql /run/postgresql "$PGSOCKET" /tmp; do
      if [ -S "$candidate/.s.PGSQL.5432" ]; then sock="$candidate"; break; fi
    done
    if [ -n "$sock" ]; then
      if gosu postgres psql -h "$sock" -U postgres -d "${POSTGRES_DB:-saakshi}" -Atc 'select 1' >/dev/null 2>&1; then break; fi
      if gosu postgres psql -h "$sock" -U "${POSTGRES_USER:-saakshi}" -d "${POSTGRES_DB:-saakshi}" -Atc 'select 1' >/dev/null 2>&1; then break; fi
    fi
    sleep 1
  done

  if [ -z "$sock" ]; then
    echo "saakshi: no postgres socket found - leaving ssl off" >&2
    return 0
  fi

  if [ ! -f "$key" ]; then
    echo "saakshi: generating a self-signed server certificate for TLS"
    openssl req -new -x509 -days 3650 -nodes -text -out "$crt" -keyout "$key" -subj "/CN=saakshi-db" >/dev/null 2>&1
    # Postgres refuses to start with a key any wider than 0600, and refuses one it does not own.
    chown "$PG_UID:$PG_GID" "$crt" "$key"
    chmod 0600 "$key"
    chmod 0644 "$crt"
  fi

  if [ ! -f "$key" ]; then
    echo "saakshi: certificate generation failed - leaving ssl off" >&2
    return 0
  fi

  # ALTER SYSTEM needs a superuser. In this image the bootstrap superuser is `postgres`; the role
  # named by POSTGRES_USER is the application role and may not have the privilege, so try the
  # superuser first and fall back. Errors are logged rather than swallowed - the previous revision
  # hid the real reason behind `2>&1 >/dev/null` and cost a deploy to diagnose.
  local out rc=1
  for role in postgres "${POSTGRES_USER:-saakshi}"; do
    out="$(gosu postgres psql -h "$sock" -U "$role" -d "${POSTGRES_DB:-saakshi}" \
      -v ON_ERROR_STOP=1 \
      -c "alter system set ssl = 'on'" \
      -c "alter system set ssl_cert_file = '$crt'" \
      -c "alter system set ssl_key_file = '$key'" \
      -c "select pg_reload_conf()" 2>&1)"
    rc=$?
    if [ "$rc" = 0 ]; then
      echo "saakshi: TLS enabled as role '$role' (self-signed; clients use sslmode=require)"
      return 0
    fi
    echo "saakshi: enabling TLS as role '$role' failed: $(echo "$out" | tr '\n' ' ' | cut -c1-300)" >&2
  done
  return 0
}

configure_tls &

exec gosu postgres /docker-entrypoint.sh "$@"
