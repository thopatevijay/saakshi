# OSRM routing for the hosted deployment (D4-13).
#
# ## Why this image builds its own graph instead of shipping one
#
# Route reconstruction and impossible-transition detection both ask OSRM one question — *"what is
# the most plausible driving path between these two cameras, and how long should it take"* — and
# without an answer every segment is `unmeasured`. On 15 Sep the deployed environment had no OSRM
# service at all, so a judge running a trace saw `0.0 km observed · 0.0 km inferred · 0 of 10
# transitions assessable`, while the same trace on a laptop drew a route and flagged a 1,109 km/h
# impossible transition. Loading `road_network` into Postgres was necessary and **not sufficient**:
# the table is the geometry coverage is computed against, the routing graph is a separate artefact.
#
# The obvious fix — copy the local `data/*.osrm*` set in — cannot work. `data/` and `*.osm.pbf` are
# in **both** `.gitignore` and `.dockerignore`, so neither `railway up` (which respects the former)
# nor the image build (the latter) can see them. That is the right call for a 1.3 GB binary nobody
# can regenerate from the repo, so this image reproduces `scripts/import-osm.sh` stages 1-3 instead:
# download the region, clip it to Gujarat, build the graph.
#
# ## The snapshot is PINNED, and here is what that cost
#
# `road_network` was imported from an OSM snapshot of **2026-09-05T20:22:06Z**, which
# `docs/claims-provenance.md` §5 publishes. Geofabrik no longer serves that day — `-260905` and
# `-260904` both 404 — so the graph here cannot be made identical to the one the coverage figures
# came from.
#
# The first build used `-latest` and that was worse than divergent, it was **not reproducible**:
# every rebuild would fetch a different snapshot and silently move a published number. Measured on
# the `-latest` build, the cloned-plate segment routed at **9.236 km → 1108.3 km/h** where local
# computes **9.244 km → 1109.3 km/h**, the figure printed in the deck and the HLD. Eight metres of
# routed path, one km/h of published claim.
#
# So this pins the oldest dated extract Geofabrik still serves. The graph is then identical on every
# rebuild, and the divergence from `road_network` is a fixed, stated quantity rather than whatever
# the mirror happened to hold that morning. Coverage kilometres are unaffected either way — they
# come from `road_network` in PostGIS, not from OSRM, which only supplies road distance between two
# camera positions.
#
# **A dated extract ages out of Geofabrik's window (~90 days).** When this build starts 404ing, that
# is why; pick the next available date and re-measure the figure above rather than reaching for
# `-latest`.
#
# ## Build cost
#
# `osrm-extract` is the slow stage and wants memory in proportion to the extract. Clipping first is
# what keeps this affordable: the western-zone download is ~220 MB and the Gujarat clip is ~72 MB.

FROM debian:bookworm-slim AS extract

# osmium-tool does the bbox clip. `scripts/import-osm.sh` documents that osmium has no usable public
# container image, which is why it is installed from Debian here rather than pulled.
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Identical to `scripts/import-osm.sh`: the same region and the same bounding box that
# `scripts/build-basemap.sh` clips the basemap to, so the routing graph and the tiles a route is
# drawn over cover exactly the same ground.
ARG REGION=western-zone
# Pinned, not `-latest`. See the snapshot note above before changing it.
ARG SNAPSHOT=260901
ARG BBOX=68.0,19.9,74.6,24.8

WORKDIR /data
# Downloaded to a .part file and moved only on success: a truncated download that keeps the final
# name is indistinguishable from a good one until osmium reports "not a PBF file".
RUN curl -fSL --retry 3 --retry-delay 5 \
      "https://download.geofabrik.de/asia/india/${REGION}-${SNAPSHOT}.osm.pbf" -o region.osm.pbf.part \
 && mv region.osm.pbf.part region.osm.pbf \
 && osmium extract --bbox "${BBOX}" --set-bounds --overwrite \
      -o gujarat-latest.osm.pbf region.osm.pbf \
 && rm -f region.osm.pbf \
 && ls -lh gujarat-latest.osm.pbf

FROM ghcr.io/project-osrm/osrm-backend:latest AS graph
WORKDIR /data
COPY --from=extract /data/gujarat-latest.osm.pbf /data/gujarat-latest.osm.pbf
# The car profile, matching the travel-time model D3-01 scores inferences against. `mld` is chosen
# at extract time and must match the algorithm `osrm-routed` serves with, below.
RUN osrm-extract -p /opt/car.lua /data/gujarat-latest.osm.pbf \
 && osrm-partition /data/gujarat-latest.osrm \
 && osrm-customize /data/gujarat-latest.osrm \
 && rm -f /data/gujarat-latest.osm.pbf

FROM ghcr.io/project-osrm/osrm-backend:latest
WORKDIR /data
COPY --from=graph /data/ /data/

# Railway injects PORT. OSRM defaults to 5000, which is also the port `api` dials over the private
# network, so the default is kept when PORT is absent. `0.0.0.0` is required: a service bound to
# loopback is unreachable from another container even on the private network.
ENV OSRM_PORT=5000
EXPOSE 5000
CMD ["sh", "-c", "osrm-routed --algorithm mld --ip 0.0.0.0 --port ${PORT:-5000} /data/gujarat-latest.osrm"]
