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
