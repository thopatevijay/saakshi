#!/usr/bin/env bash
# Bring the whole of SAAKSHI up with one command: services, schema, seed, API, web.
#
# ## Why a script rather than `docker compose up && npm run dev`
#
# Four things have to happen in order, and three of them have failed silently at least once during
# this build:
#
#   1. **OSRM needs a non-default host port on macOS.** AirPlay Receiver owns 5000, so plain
#      `docker compose up` dies with `ports are not available` — and the routing profile is opt-in,
#      so forgetting `--profile routing` means route reconstruction returns nothing with no error.
#   2. **Migrations must land before the API starts**, or Drizzle queries a table that isn't there.
#   3. **An unseeded estate looks like a broken app**, not an empty one: the map is blank, the alert
#      queue is empty, and every camera-count assertion fails. Seeding is part of "started".
#   4. **`sync:catalogue` fails with HTTP 200.** The sandbox gateway serves an HTML login page with a
#      success status when the session cookie is dead, so a naive script reports success and leaves
#      you with zero cameras. We check the row count, not the exit code.
#
# Idempotent: safe to re-run. Already-running services are left alone, migrations no-op, and the
# estate is only re-seeded when it is actually empty.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

RUN_DIR=".run"
mkdir -p "$RUN_DIR"

# macOS: AirPlay Receiver holds 5000 and cannot be evicted without disabling the feature, so the
# host port moves. Linux and Railway keep the upstream default.
if [[ -z "${OSRM_HOST_PORT:-}" && "$(uname -s)" == "Darwin" ]]; then
  export OSRM_HOST_PORT=5050
fi
export OSRM_HOST_PORT="${OSRM_HOST_PORT:-5000}"
export OSRM_URL="${OSRM_URL:-http://localhost:${OSRM_HOST_PORT}}"

MODE=dev
[[ "${1:-}" == "--prod" ]] && MODE=prod

API_PORT="${API_PORT:-4000}"
WEB_PORT="${WEB_PORT:-3000}"

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$1"; }

# ── 1 · infrastructure ────────────────────────────────────────────────────────
say "Starting services (Postgres · Valkey · MinIO · MediaMTX · OSRM · Prometheus · Grafana)"
if ! docker info >/dev/null 2>&1; then
  echo "  Docker is not running. Start Docker Desktop and re-run." >&2
  exit 1
fi
docker compose --profile routing up -d >/dev/null 2>&1
until docker compose ps --format '{{.Service}} {{.State}}' | grep -q '^db running'; do sleep 1; done
until docker compose exec -T db pg_isready -U saakshi -q 2>/dev/null; do sleep 1; done
ok "services up · OSRM on host port ${OSRM_HOST_PORT}"

# ── 2 · schema ────────────────────────────────────────────────────────────────
say "Applying migrations"
npm run db:migrate 2>&1 | grep -E 'applied|up to date' | tail -2 || true

# ── 3 · estate ────────────────────────────────────────────────────────────────
# `.env` holds the sandbox session cookie. Sourced, never printed — the values go into the
# environment for the tools to consume and must not reach a terminal or a log.
set -a; [[ -f .env ]] && . ./.env; set +a
export OSRM_URL="http://localhost:${OSRM_HOST_PORT}"

DB="${DATABASE_URL:-postgres://saakshi:saakshi@localhost:5432/saakshi}"
cams=$(psql "$DB" -tAc 'select count(*) from cameras' 2>/dev/null || echo 0)
if [[ "$cams" -eq 0 ]]; then
  say "Seeding the camera estate"
  npm run sync:catalogue >/dev/null 2>&1 || true
  cams=$(psql "$DB" -tAc 'select count(*) from cameras' 2>/dev/null || echo 0)
  if [[ "$cams" -eq 0 ]]; then
    # The gateway answers 200 with an HTML login page when the cookie is dead, so an exit code
    # tells us nothing. The row count is the only honest check.
    warn "estate is empty — SENTINEL_PORTAL_COOKIE is probably expired."
    warn "refresh it in .env, or import the offline fixture:"
    warn "  fixtures/cameras-bulk-sample.csv via POST /api/v1/cameras/bulk"
  else
    ok "$cams cameras"
  fi
else
  ok "$cams cameras already present"
fi

# ── 4 · application ───────────────────────────────────────────────────────────
# Both servers are launched inside `( … & )` — a subshell that exits immediately, orphaning the
# child to init. `&` plus `disown` is not enough: the child still holds the script's stdout, so a
# piped `npm start | tail` never sees EOF and appears to hang forever while everything is actually
# running. The double-fork severs that inheritance.
#
# `next dev` rather than `next start`: a production build costs minutes on every start, which makes
# this command useless for the thing it exists for. Pass --prod for the built output, which is what
# a demo recording or a judge-facing deployment needs.
say "Starting API and web"
npm run build --workspace @saakshi/shared >/dev/null 2>&1

if curl -sf -o /dev/null "http://localhost:${API_PORT}/health" 2>/dev/null; then
  ok "API already running on :${API_PORT}"
else
  API_LOG="$PWD/$RUN_DIR/api.log"; API_PID="$PWD/$RUN_DIR/api.pid"
  # `exec` replaces the SUBSHELL's descriptors before forking, so the server inherits the log file
  # rather than whatever stdout the script was given. Redirecting only the command is not enough:
  # the subshell still holds the caller's pipe, and `npm start | tee` then hangs forever with
  # everything running perfectly.
  ( exec < /dev/null > "$API_LOG" 2>&1
    API_PORT="$API_PORT" npx tsx packages/api/src/index.ts & echo $! > "$API_PID" )
  until curl -sf -o /dev/null "http://localhost:${API_PORT}/health" 2>/dev/null; do sleep 1; done
  ok "API on :${API_PORT}"
fi

if curl -sf -o /dev/null "http://localhost:${WEB_PORT}/login" 2>/dev/null; then
  ok "web already running on :${WEB_PORT}"
else
  WEB_LOG="$PWD/$RUN_DIR/web.log"; WEB_PID="$PWD/$RUN_DIR/web.pid"
  if [[ "$MODE" == "prod" ]]; then
    say "Building web for production (this takes a minute)"
    npm run build --workspace @saakshi/web >/dev/null 2>&1
    ( exec < /dev/null > "$WEB_LOG" 2>&1
      cd packages/web && API_BASE_URL="http://localhost:${API_PORT}" \
        npx next start -p "$WEB_PORT" & echo $! > "$WEB_PID" )
  else
    ( exec < /dev/null > "$WEB_LOG" 2>&1
      cd packages/web && API_BASE_URL="http://localhost:${API_PORT}" \
        npx next dev -p "$WEB_PORT" & echo $! > "$WEB_PID" )
  fi
  until curl -sf -o /dev/null "http://localhost:${WEB_PORT}/login" 2>/dev/null; do sleep 1; done
  ok "web on :${WEB_PORT} (${MODE})"
fi

cat <<BANNER

  ────────────────────────────────────────────────────────────────
   SAAKSHI is up

     app        http://localhost:${WEB_PORT}
     api docs   http://localhost:${API_PORT}/docs
     grafana    http://localhost:3001          admin / admin
     minio      http://localhost:9001          saakshi / saakshi-dev-secret

     sign in    GP-ADM-0001 / saakshi-dev      (admin)
                GP-OPR-1042 / saakshi-dev      (operator)
                GP-AUD-0007 / saakshi-dev      (auditor — read-only, /trace is 403)

     mode       ${MODE}  (npm start -- --prod builds and serves the production output)
     logs       .run/api.log · .run/web.log
     stop       npm run stop
  ────────────────────────────────────────────────────────────────

BANNER
