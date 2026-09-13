# Valkey for the hosted deployment (D4-01).
#
# This exists only to carry a CMD. Railway can deploy a bare image, but the start command for an
# image-based service is a dashboard field the CLI cannot set — and the two flags below are not
# optional, so leaving them to a click that someone has to remember is how a deployment silently
# loses its event bus. Baking them into a two-line image keeps the deploy reproducible from the
# repository, which is the same reason ops/mediamtx/mediamtx.yml is a file rather than MTX_* vars.
FROM valkey/valkey:8-alpine

# `--appendonly yes` is what makes the attached volume mean anything: without it Valkey keeps the
# stream in memory and a redeploy silently starts from empty, which would look like a working
# service that had simply never seen any traffic.
#
# `--requirepass` because Railway's private network is project-scoped but the process would
# otherwise accept any connection that reaches it, and because Valkey refuses external connections
# under protected-mode unless a password is set.
CMD ["sh", "-c", "exec valkey-server --appendonly yes --requirepass \"$VALKEY_PASSWORD\""]
