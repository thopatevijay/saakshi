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

# Final, definitive sweep: whatever still holds the ports goes, whoever started it and however it
# was named. A recorded pid can be stale (the servers fork, so the pid we captured may already have
# exited while its child still listens), and a name pattern can miss a mode we did not anticipate.
# The port is the thing that actually blocks the next start, so the port is what we check.
for entry in "API:${API_PORT:-4000}" "web:${WEB_PORT:-3000}"; do
  name="${entry%%:*}"; port="${entry##*:}"
  holders=$(lsof -ti ":$port" 2>/dev/null || true)
  if [[ -n "$holders" ]]; then
    echo "$holders" | xargs kill -TERM 2>/dev/null || true
    sleep 1
    holders=$(lsof -ti ":$port" 2>/dev/null || true)
    [[ -n "$holders" ]] && echo "$holders" | xargs kill -KILL 2>/dev/null || true
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
