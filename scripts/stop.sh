#!/usr/bin/env bash
# Stop everything `scripts/start.sh` started.
#
# ## Why this is not just `docker compose down`
#
# The API and web run as host processes, not containers, so compose knows nothing about them. Left
# behind they hold :4000 and :3000, and the next `start` silently attaches to a *stale build* —
# which cost two false bug reports during this build.
#
# ## Why volumes are preserved by default
#
# `docker compose down -v` destroys `miniodata`, and MinIO holds the D2-02 evidence crops. Those
# cannot be regenerated without gateway traffic, and the sandbox session expires. Losing them costs
# evidence the submission needs. Pass `--purge` only when you genuinely want a bare machine.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/processes.sh
. scripts/lib/processes.sh

RUN_DIR=".run"
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }

# stop_proc <name> <pgrep pattern> <grace seconds>
# TERM, wait for a clean exit, then KILL whatever is left. The pidfile is only a hint: the consumers
# run under `npx tsx`, which forks, and a process started by hand never had a pidfile at all.
stop_proc() {
  local name="$1" pattern="$2" grace="$3" waited=0
  rm -f "$RUN_DIR/$name.pid"
  pgrep -f "$pattern" >/dev/null 2>&1 || return 0
  pkill -TERM -f "$pattern" 2>/dev/null || true
  while pgrep -f "$pattern" >/dev/null 2>&1 && (( waited < grace )); do sleep 1; waited=$((waited + 1)); done
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    pkill -KILL -f "$pattern" 2>/dev/null || true
    ok "$name stopped (forced after ${grace} s)"
  else
    ok "$name stopped"
  fi
}

# ## Nothing to stop is one line, not a report (D4-16)
#
# A repeated `stop` used to walk every section, warn about another app on :3000 and announce
# "containers stopped" for containers that were never running. Output an operator cannot trust is
# worse than none, so with nothing up we say exactly that and leave.
saakshi_containers() { docker compose --profile routing ps -q 2>/dev/null | grep -c . || true; }
adminer_exists() { [[ -n "$(docker ps -aq -f name='^saakshi-adminer$' 2>/dev/null)" ]]; }
if [[ "$PURGE" -eq 0 ]] \
  && ! pgrep -f "$PAT_API|$PAT_WEB|$PAT_SIGHTINGS|$PAT_EVIDENCE|$PAT_WORKER" >/dev/null 2>&1 \
  && [[ "$(saakshi_containers)" -eq 0 ]] && ! adminer_exists; then
  rm -f "$PORTS_FILE" "$RUN_DIR"/*.pid
  printf '\n  SAAKSHI is already down — nothing to stop.\n\n'
  exit 0
fi

# ## Why the pipeline goes first, and before the containers
#
# The consumers honour SIGTERM only between reads, and a read blocks on Valkey. Stop Valkey first and
# the read never returns, so the abort is never seen: on 5 Oct 2026 two consumers outlived a
# `stop` by two hours, writing 1.3 MB of ECONNREFUSED retries (D4-14). The worker goes before the
# consumers so its last sightings still have someone to drain them, and it gets the longest grace
# because it finishes the frame in hand and prints its run summary on the way out.
say "Stopping the live pipeline"
stop_proc worker "$PAT_WORKER" 15
stop_proc consume-sightings "$PAT_SIGHTINGS" 10
stop_proc consume-evidence "$PAT_EVIDENCE" 10

say "Stopping API and web"
# By pattern, not by process group. The old `kill -- -<pgid>` was right only when `npm start` ran in
# its own interactive job; run `start` and `stop` from one script and that group is the caller's
# shell, which then kills itself (D4-14).
stop_proc api "$PAT_API" 10
stop_proc web "$PAT_WEB" 10

# Final sweep: a SAAKSHI process still holding a port goes, however it was started and named. A
# pattern can miss a mode we did not anticipate, and the port is the thing that actually blocks the
# next start, so the port is what we check.
# The ports start.sh actually chose (D4-15): after a move to :3001+, the default is the wrong place
# to look, and it is exactly where the foreign holder lives.
if [[ -f "$PORTS_FILE" ]]; then
  API_PORT="${API_PORT:-$(sed -n 's/^API_PORT=//p' "$PORTS_FILE")}"
  WEB_PORT="${WEB_PORT:-$(sed -n 's/^WEB_PORT=//p' "$PORTS_FILE")}"
fi
for entry in "API:${API_PORT:-4000}" "web:${WEB_PORT:-3000}"; do
  name="${entry%%:*}"; port="${entry##*:}"
  # Only a holder whose command line points into THIS repo is ours. On 5 Oct 2026 this sweep killed
  # whatever held :3000, which was Docker Desktop's port forwarder for an unrelated project's
  # container, and Docker Desktop went down with every container on the machine (D4-14). A port is
  # not proof of ownership; a path inside the repo is.
  ours=()
  for pid in $(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null || true); do
    # A holder outside this repo is not ours to stop, and not ours to report either: `stop` never
    # touched it, and warning about it on every run is noise (D4-16).
    ps -o command= -p "$pid" 2>/dev/null | grep -qF "$PWD" && ours+=("$pid")
  done
  if (( ${#ours[@]} )); then
    kill -TERM "${ours[@]}" 2>/dev/null || true
    sleep 1
    kill -KILL "${ours[@]}" 2>/dev/null || true
    ok "$name port $port released"
  fi
done

say "Stopping services"
if [[ "$PURGE" -eq 1 ]]; then
  docker compose --profile routing down -v >/dev/null 2>&1
  ok "containers and volumes removed — Postgres, MinIO and Grafana data are gone"
elif [[ "$(saakshi_containers)" -gt 0 ]]; then
  docker compose --profile routing down >/dev/null 2>&1
  ok "containers stopped, volumes preserved"
else
  ok "no containers were running"
fi

if adminer_exists; then
  docker rm -f saakshi-adminer >/dev/null 2>&1 && ok "adminer stopped"
fi

rm -f "$PORTS_FILE"

printf '\n  SAAKSHI is down. Start again with: npm start\n\n'
