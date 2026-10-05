# Process patterns shared by start.sh and stop.sh. Sourced, never run.
#
# ## Why every pattern is anchored to the interpreter
#
# `pgrep -f` / `pkill -f` match the WHOLE command line of every process on the machine. An
# unanchored `workers.analytics.run` also matches any shell, editor or terminal whose arguments
# merely mention it, and on 5 Oct 2026 `npm run stop` killed the shell that invoked it that way
# (D4-14). Anchoring on the interpreter at the start of the command line (`node`, `npm exec`,
# `python`) matches the process that IS the service, never one that talks about it.
#
# The `npm exec` / `node …/tsx` / `node --require …` triple is one service: npx forks twice, and all
# three must go or the survivor keeps the port or the consumer-group seat.
# shellcheck disable=SC2034  # consumed by the sourcing script
NODE_PREFIX='^([^ ]*/)?(node|npm) '
PAT_API="${NODE_PREFIX}.*packages/api/src/index\.ts"
PAT_WEB="${NODE_PREFIX}.*next (dev|start) -p"
PAT_SIGHTINGS="${NODE_PREFIX}.*consumers/sightings-cli\.ts"
PAT_EVIDENCE="${NODE_PREFIX}.*consumers/evidence-cli\.ts"
PAT_WORKER='^[^ ]*[Pp]ython[0-9.]* -m workers\.analytics\.run'

running() { pgrep -f "$1" >/dev/null 2>&1; }

# ## Port ownership (D4-15)
#
# "Something answered on :3000" is not "SAAKSHI is running on :3000". Another project's dev server
# answers /login with a 200 too, and on 5 Oct 2026 start.sh reported the web as running while the
# browser showed somebody else's login page. A listener is ours only if its command line points into
# this repository.

# port_state <port> → "free" | "ours" | "foreign <process name>"
port_state() {
  local pids pid
  pids=$(lsof -ti ":$1" -sTCP:LISTEN 2>/dev/null || true)
  [[ -z "$pids" ]] && { echo free; return; }
  for pid in $pids; do
    ps -o command= -p "$pid" 2>/dev/null | grep -qF "$PWD" && { echo ours; return; }
  done
  pid=${pids%%$'\n'*}
  echo "foreign $(basename "$(ps -o comm= -p "$pid" 2>/dev/null)")"
}

# free_port_from <port> → the first port at or above it that nothing listens on
free_port_from() {
  local port="$1"
  while [[ "$(port_state "$port")" != free ]]; do port=$((port + 1)); done
  echo "$port"
}

# The ports start.sh actually chose, so a second start and stop.sh use the real ones.
PORTS_FILE=".run/ports"
