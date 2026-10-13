# MinIO for the hosted deployment (D4-01).
#
# The image has no usable default command — `minio` without `server /data` prints help and exits —
# so a start command is mandatory rather than a preference, and Railway's image services take
# theirs from a dashboard field the CLI cannot set. Hence this file.
#
# **Built from source, pinned.** MinIO stopped publishing free container images: on 13 Oct 2026
# `quay.io/minio/minio:latest` returned 401 to Railway's builder, and docker.io / quay.io refused
# every release tag tried, including RELEASE.2025-09-07T16-13-09Z (the version the local compose
# stack runs from a cached pull). The source is AGPL-3.0 and public, so the builder compiles that
# same release natively for whatever architecture it runs on — no registry, no arch mismatch.
FROM golang:1.24-alpine AS build
ARG MINIO_RELEASE=RELEASE.2025-09-07T16-13-09Z
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "${MINIO_RELEASE}" https://github.com/minio/minio /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /usr/bin/minio . \
 && CGO_ENABLED=0 GOBIN=/usr/bin go install github.com/minio/mc@latest

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /usr/bin/minio /usr/bin/minio
COPY --from=build /usr/bin/mc /usr/bin/mc
ENTRYPOINT ["/usr/bin/minio"]

# 9000 is the S3 API, which only the API service dials, over the private network.
#
# 9001 is the console, and it is bound but **never given a public domain** — that is the acceptance
# criterion. Binding it costs nothing and keeps `railway ssh` port-forwarding available to an
# operator who needs to look inside the bucket; not publishing a domain is what keeps it private.
EXPOSE 9000 9001
CMD ["server", "/data", "--address", ":9000", "--console-address", ":9001"]
