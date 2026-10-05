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
# shellcheck source=scripts/lib/processes.sh
. scripts/lib/processes.sh

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
WORKER=1
for arg in "$@"; do
  case "$arg" in
    --prod) MODE=prod ;;
    --no-worker) WORKER=0 ;;
    *) echo "unknown option: $arg (expected --prod and/or --no-worker)" >&2; exit 2 ;;
  esac
done

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

# ── 5 · the live pipeline ─────────────────────────────────────────────────────
# Without these three the console comes up looking healthy and never receives anything live: the
# consumers turn the Valkey streams into rows and alerts, and the worker turns video into the
# streams. Until D4-14 they were started by hand, and a cold-start run lost its first plate to it.
#
# `running` (scripts/lib/processes.sh) checks the process table, not a pidfile: a consumer started by
# hand in another terminal must count as running, or this would start a second one in the same
# consumer group.

# start_bg <name> <pgrep pattern> <ready marker> <wait seconds> <command…>
# Returns 0 when the marker appears, 1 when the process died, 2 when it is alive but not yet ready.
start_bg() {
  local name="$1" pattern="$2" marker="$3" wait_s="$4"; shift 4
  local log="$PWD/$RUN_DIR/$name.log" pidfile="$PWD/$RUN_DIR/$name.pid"
  ( exec < /dev/null > "$log" 2>&1
    "$@" & echo $! > "$pidfile" )
  local waited=0
  while (( waited < wait_s )); do
    grep -q "$marker" "$log" 2>/dev/null && return 0
    running "$pattern" || return 1
    sleep 1; waited=$((waited + 1))
  done
  return 2
}

say "Starting the live pipeline (consumers · analytics worker)"
for consumer in sightings evidence; do
  if [[ "$consumer" == sightings ]]; then pattern="$PAT_SIGHTINGS"; else pattern="$PAT_EVIDENCE"; fi
  if running "$pattern"; then
    ok "$consumer consumer already running"
    continue
  fi
  if start_bg "consume-$consumer" "$pattern" "consuming $consumer as group" 60 \
      npx tsx "packages/api/src/consumers/${consumer}-cli.ts"; then
    ok "$consumer consumer"
  else
    echo "  $consumer consumer did not start — last lines of $RUN_DIR/consume-$consumer.log:" >&2
    tail -5 "$RUN_DIR/consume-$consumer.log" >&2
    exit 1
  fi
done

# The worker is optional; the core stack is not. A judge cloning without Python still gets a
# working console, so a missing interpreter is a warning, never a failed start.
WORKER_PATTERN="$PAT_WORKER"
if [[ "$WORKER" -eq 0 ]]; then
  warn "analytics worker skipped (--no-worker)"
elif [[ ! -x .venv/bin/python ]]; then
  warn "analytics worker skipped: no .venv — see README § Python CV workers"
elif running "$WORKER_PATTERN"; then
  ok "analytics worker already running"
else
  # Scope: registry cameras and/or ad-hoc `id=url` sources. `${VAR-default}` rather than `:-`, so
  # `SAAKSHI_WORKER_CAMERAS=` (set, empty) means "sources only" instead of falling back to cam04/05.
  worker_args=()
  read -r -a cams <<< "${SAAKSHI_WORKER_CAMERAS-cam04 cam05}"
  (( ${#cams[@]} )) && worker_args+=(--cameras "${cams[@]}")
  read -r -a srcs <<< "${SAAKSHI_WORKER_SOURCES:-}"
  for src in "${srcs[@]+"${srcs[@]}"}"; do worker_args+=(--source "$src"); done
  if (( ${#worker_args[@]} == 0 )); then
    warn "analytics worker skipped: SAAKSHI_WORKER_CAMERAS and SAAKSHI_WORKER_SOURCES are both empty"
  else
    # ANPR and evidence on: without them the worker produces vehicles and silently no plates.
    # The sandbox has measured 82 s for a single open, so the start does not block on "connected"
    # for longer than a minute; the worker keeps connecting in the background.
    set +e
    start_bg worker "$WORKER_PATTERN" "cameras connected" 60 \
      .venv/bin/python -m workers.analytics.run "${worker_args[@]}" --anpr --evidence --minutes 0
    rc=$?
    set -e
    case "$rc" in
      0) ok "analytics worker · ${worker_args[*]} · ANPR + evidence" ;;
      2) warn "analytics worker still connecting after 60 s — watch $RUN_DIR/worker.log" ;;
      *) warn "analytics worker exited — last lines of $RUN_DIR/worker.log:"
         grep -vE '^objc|Class AV' "$RUN_DIR/worker.log" | tail -5 >&2 ;;
    esac
  fi
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
                .run/consume-sightings.log · .run/consume-evidence.log · .run/worker.log
     stop       npm run stop
  ────────────────────────────────────────────────────────────────

BANNER
