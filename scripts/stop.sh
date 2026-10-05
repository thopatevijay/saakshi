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

# ## Why the pipeline goes first, and before the containers
#
# The consumers honour SIGTERM only between reads, and a read blocks on Valkey. Stop Valkey first and
# the read never returns, so the abort is never seen: on 5 Oct 2026 two consumers outlived a
# `stop` by two hours, writing 1.3 MB of ECONNREFUSED retries (D4-14). The worker goes before the
# consumers so its last sightings still have someone to drain them, and it gets the longest grace
# because it finishes the frame in hand and prints its run summary on the way out.
say "Stopping the live pipeline"
stop_proc worker 'workers.analytics.run' 15
stop_proc consume-sightings 'consumers/sightings-cli.ts' 10
stop_proc consume-evidence 'consumers/evidence-cli.ts' 10

say "Stopping API and web"
for svc in api web; do
  pidfile="$RUN_DIR/$svc.pid"
  if [[ -f "$pidfile" ]]; then
    pid=$(cat "$pidfile")
    # The recorded pid is the shell's child; `next` and `tsx` fork, so kill the process group to
    # avoid orphaning a listener that then blocks the port on the next start.
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM -"$(ps -o pgid= "$pid" | tr -d ' ')" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      ok "$svc stopped (pid $pid)"
    fi
    rm -f "$pidfile"
  fi
done

# Belt and braces: a process started by hand outside this script still holds the port, and the
# symptom ("port in use", or worse, a stale build answering) is confusing enough to be worth this.
pkill -f 'tsx packages/api/src/index.ts' 2>/dev/null && ok "stray API process stopped" || true
pkill -f 'next (dev|start) -p' 2>/dev/null && ok "stray web process stopped" || true

# Final sweep: a SAAKSHI process still holding a port goes, however it was started and named. A recorded pid can be stale (the servers fork, so the pid we captured may already have
# exited while its child still listens), and a name pattern can miss a mode we did not anticipate.
# The port is the thing that actually blocks the next start, so the port is what we check.
for entry in "API:${API_PORT:-4000}" "web:${WEB_PORT:-3000}"; do
  name="${entry%%:*}"; port="${entry##*:}"
  # Only a holder whose command line points into THIS repo is ours. On 5 Oct 2026 this sweep killed
  # whatever held :3000, which was Docker Desktop's port forwarder for an unrelated project's
  # container, and Docker Desktop went down with every container on the machine (D4-14). A port is
  # not proof of ownership; a path inside the repo is.
  ours=()
  for pid in $(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null || true); do
    if ps -o command= -p "$pid" 2>/dev/null | grep -qF "$PWD"; then
      ours+=("$pid")
    else
      printf '  \033[33m!\033[0m %s port %s is held by %s (not SAAKSHI) — left alone\n' \
        "$name" "$port" "$(ps -o comm= -p "$pid" 2>/dev/null | xargs basename 2>/dev/null)"
    fi
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
else
  docker compose --profile routing down >/dev/null 2>&1
  ok "containers stopped, volumes preserved"
fi

docker rm -f saakshi-adminer >/dev/null 2>&1 && ok "adminer stopped" || true

printf '\n  SAAKSHI is down. Start again with: npm start\n\n'
