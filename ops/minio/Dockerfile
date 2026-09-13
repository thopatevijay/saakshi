# MinIO for the hosted deployment (D4-01).
#
# The base image has no usable default command — `minio` without `server /data` prints help and
# exits — so a start command is mandatory rather than a preference, and Railway's image services
# take theirs from a dashboard field the CLI cannot set. Hence this file.
# **quay.io, not Docker Hub.** `docker.io/minio/minio:latest` now refuses an anonymous pull —
# `insufficient_scope: authorization failed` — so a builder with no cached copy cannot fetch it.
# A laptop that pulled the image months ago does not notice; a clean CI builder fails outright.
# quay.io is MinIO's own registry and serves the same image anonymously (verified: HTTP 200).
FROM quay.io/minio/minio:latest

# 9000 is the S3 API, which only the API service dials, over the private network.
#
# 9001 is the console, and it is bound but **never given a public domain** — that is the acceptance
# criterion. Binding it costs nothing and keeps `railway ssh` port-forwarding available to an
# operator who needs to look inside the bucket; not publishing a domain is what keeps it private.
CMD ["server", "/data", "--address", ":9000", "--console-address", ":9001"]
