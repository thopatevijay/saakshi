#!/usr/bin/env bash
# Build the road graph: OSM -> OSRM routing graph -> `road_network` in PostGIS (D3-01).
#
# Route reconstruction needs two different things out of the same OSM data, and this script
# produces both from one download:
#
#   1. an **OSRM routing graph** (`data/gujarat-latest.osrm*`) that answers "what is the most
#      plausible driving path between these two cameras, and how long should it take" — the
#      travel-time model D3-01 scores an inference against and D3-02 inverts;
#   2. the **`road_network` table** — the road geometry itself, GiST-indexed, which camera coverage
#      (`camera_coverage.covered_road_ids`) and D3-06's gap analysis are computed against.
#
# ## Where the data comes from, and why it is not called "Gujarat" upstream
#
# **Geofabrik publishes no standalone Gujarat extract.** The smallest region containing Gujarat is
# `asia/india/western-zone` (~220 MB: Gujarat, Maharashtra, Goa, Dadra & Nagar Haveli, Daman & Diu).
# This script downloads that once and clips it to the Gujarat bounding box — the *same* bbox
# `scripts/build-basemap.sh` clips the basemap to, so the routing graph and the tiles a route is
# drawn over cover exactly the same ground. The clipped file is written as
# `data/gujarat-latest.osm.pbf`, which is the filename `docker-compose.yml`'s `osrm` service already
# expects, so no compose change is needed.
#
# (c) OpenStreetMap contributors, ODbL. The same licence and attribution as the basemap.
#
# ## Everything lives in `data/`, which is gitignored
#
# The extract, the clipped pbf and the `.osrm*` graph files are hundreds of megabytes and are never
# committed. A fresh clone therefore has no road graph until this script has been run once, and
# `docker compose --profile routing up osrm` on such a checkout exits immediately. This script is
# how that becomes reproducible; `docs/road-network-setup.md` is how it becomes findable.
#
# ## Idempotent by stage
#
# Each stage is skipped when its output is already newer than its input, so a re-run after a failed
# database import does not re-download 220 MB or rebuild a ten-minute graph. `FORCE=1` redoes
# everything.
#
# Usage:
#   ./scripts/import-osm.sh                 # download, clip, build the graph, import, serve
#   FORCE=1 ./scripts/import-osm.sh         # ignore every cached stage
#   SKIP_SERVE=1 ./scripts/import-osm.sh    # build and import, but do not start the osrm container
#   REGION=northern-zone ./scripts/import-osm.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/data"

REGION="${REGION:-western-zone}"
# Gujarat spans roughly 68.16-74.47 E and 20.06-24.71 N. Padded, in the GeoJSON/MapLibre ordering
# (minLon,minLat,maxLon,maxLat). Identical to `scripts/build-basemap.sh`'s BBOX on purpose.
BBOX="${BBOX:-68.0,19.9,74.6,24.8}"
DATABASE_URL="${DATABASE_URL:-postgres://saakshi:saakshi@localhost:5432/saakshi}"

# The driveable public road network. `service`, `track`, `path`, `footway`, `cycleway` and friends
# are deliberately excluded: they are not where a number plate gets read, they multiply the row
# count several-fold, and a gap-analysis figure computed over farm tracks is not a figure anyone
# should quote. The `_link` classes are kept, because a slip road is how a vehicle actually joins a
# highway and a route that skipped them would place a segment on the wrong carriageway.
HIGHWAY_CLASSES="${HIGHWAY_CLASSES:-motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link,tertiary,tertiary_link,unclassified,residential,living_street,road}"

OSRM_IMAGE="${OSRM_IMAGE:-osrm/osrm-backend:latest}"
# osmium-tool has **no public container image**: `ghcr.io/osmcode/osmium-tool` and the community
# mirrors all answer `denied` to an unauthenticated pull (checked 2026-09-05). So it is a native
# dependency — `brew install osmium-tool` / `apt-get install osmium-tool` — and this script says so
# rather than failing four stages later with a missing binary.
OSMIUM_BIN="${OSMIUM_BIN:-osmium}"

SRC="$DATA/${REGION}-latest.osm.pbf"
CLIPPED="$DATA/gujarat-latest.osm.pbf"
HIGHWAYS="$DATA/gujarat-highways.osm.pbf"
GEOJSON="$DATA/gujarat-highways.geojsonseq"
TSV="$DATA/gujarat-highways.tsv"
GRAPH="$DATA/gujarat-latest.osrm"
# `osrm-customize` writes this one last, so its presence is what "the graph is built" means.
GRAPH_STAMP="$DATA/gujarat-latest.osrm.mldgr"

FORCE="${FORCE:-}"
SKIP_SERVE="${SKIP_SERVE:-}"

say() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }

need curl
need docker
need jq
need psql
command -v "$OSMIUM_BIN" >/dev/null 2>&1 || {
  echo "missing osmium-tool. macOS: brew install osmium-tool · Debian: apt-get install osmium-tool" >&2
  exit 1
}

mkdir -p "$DATA"

# `osrm-*` runs in a container, mounting `data/` at `/data` — the same mount the compose `osrm`
# service uses, so every path handed to it below is the path the running server will see. `osmium`
# is native and takes host paths, so it is called through `$OSMIUM_BIN` directly.
#
# There is deliberately **no** `osmium()` wrapper function here. One was written, and a shell
# function named `osmium` whose body calls `osmium` resolves to itself: unbounded recursion, stack
# overflow, exit 139, and no message at all. It looks exactly like a segfault in libosmium.
osrm() { docker run --rm -t -v "$DATA:/data" "$OSRM_IMAGE" "$@"; }

newer_than() { [ -z "$FORCE" ] && [ -f "$1" ] && [ "$1" -nt "$2" ]; }

# -- 1 - the extract ----------------------------------------------------------------------------
if [ -n "$FORCE" ] || [ ! -s "$SRC" ]; then
  say "downloading $REGION from Geofabrik (~220 MB, once)"
  # `-L` is load-bearing: Geofabrik 302s `-latest` to the dated file, and following the redirect is
  # the difference between a pbf and a 252-byte HTML stub that fails much later with a confusing
  # "not a PBF file" from osmium.
  curl -fSL --progress-bar \
    "https://download.geofabrik.de/asia/india/${REGION}-latest.osm.pbf" -o "$SRC.part"
  mv "$SRC.part" "$SRC"
else
  say "extract already present: $(basename "$SRC") ($(du -h "$SRC" | cut -f1))"
fi

# -- 2 - clip to Gujarat ------------------------------------------------------------------------
if newer_than "$CLIPPED" "$SRC"; then
  say "clipped extract is up to date: $(basename "$CLIPPED") ($(du -h "$CLIPPED" | cut -f1))"
else
  say "clipping to the Gujarat bbox $BBOX"
  # `complete_ways` keeps every way that touches the box whole, including the nodes that fall
  # outside it. Without that, a highway crossing the state boundary is truncated mid-way and OSRM
  # cannot route along it — the routes that break are exactly the long-distance ones an
  # interstate-movement question depends on.
  "$OSMIUM_BIN" extract --overwrite --bbox "$BBOX" --strategy=complete_ways -o "$CLIPPED" "$SRC"
fi

# -- 3 - the OSRM routing graph -----------------------------------------------------------------
if newer_than "$GRAPH_STAMP" "$CLIPPED"; then
  say "routing graph is up to date: $(basename "$GRAPH_STAMP")"
else
  say "osrm-extract (car profile) - this is the slow one"
  osrm osrm-extract -p /opt/car.lua "/data/$(basename "$CLIPPED")"
  say "osrm-partition"
  osrm osrm-partition "/data/$(basename "$GRAPH")"
  say "osrm-customize"
  osrm osrm-customize "/data/$(basename "$GRAPH")"
fi

# -- 4 - road_network ---------------------------------------------------------------------------
# The table and its GiST index are created by migration 0003; this only fills it. Filter first,
# then export: `osmium export` assembles way geometry, which is far cheaper over the few per cent
# of ways that are roads than over every way in the file.
if newer_than "$GEOJSON" "$CLIPPED"; then
  say "highway GeoJSON is up to date: $(basename "$GEOJSON")"
else
  say "filtering to the driveable road classes"
  "$OSMIUM_BIN" tags-filter --overwrite -o "$HIGHWAYS" "$CLIPPED" "w/highway=$HIGHWAY_CLASSES"
  say "exporting way geometry"
  # `--add-unique-id=type_id` puts `w<id>` in the feature id, which is where `road_network.id`
  # comes from: a stable OSM way id rather than a row counter.
  "$OSMIUM_BIN" export --overwrite -f geojsonseq --add-unique-id=type_id -o "$GEOJSON" "$HIGHWAYS"
fi

say "flattening to TSV for COPY"
# `@tsv` escapes tabs, newlines and backslashes exactly the way COPY's text format un-escapes them,
# so a road called `Ring Road \ Bypass` survives the round trip. Missing names and classes come out
# as the empty string and become NULL in the INSERT - cheaper than teaching jq to emit a literal
# NULL marker that `@tsv` would then escape back into harmlessness.
# `tr -d '\036'` strips the RFC 7464 record separator that `geojsonseq` prefixes every line with.
# Without it jq stops on the first byte: `parse error: Invalid numeric literal at line 1, column 2`.
# jq's own `--seq` reads it, but also *emits* RS on output, which would corrupt the TSV.
tr -d '\036' < "$GEOJSON" | jq -c -r '
  select(.geometry.type == "LineString")
  | select((.geometry.coordinates | length) >= 2)
  | (.id // "" | tostring) as $rid
  | select($rid | test("^w[0-9]+$"))
  | [ ($rid | ltrimstr("w")),
      (.properties.name // ""),
      (.properties.highway // ""),
      "SRID=4326;LINESTRING(" +
        ([.geometry.coordinates[] | "\(.[0]) \(.[1])"] | join(",")) + ")" ]
  | @tsv' > "$TSV"
say "importing $(wc -l < "$TSV" | tr -d ' ') ways into road_network"

# Loaded through a staging table and swapped inside one transaction, so a half-finished COPY can
# never leave the table holding a subset of the roads. A silently short road network makes every
# coverage and gap figure quietly wrong rather than obviously broken.
#
# `distinct on (id)`: `--strategy=complete_ways` keeps ways whole across the bbox edge, so the same
# way can be emitted more than once. The primary key is the OSM way id, so a re-import reproduces
# the same ids and `camera_coverage.covered_road_ids` does not rot between imports.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
begin;
create temporary table road_import (
  id bigint, name text, highway_class text, geom geography(LineString, 4326)
) on commit drop;
\copy road_import (id, name, highway_class, geom) from '$TSV'
truncate road_network;
insert into road_network (id, name, highway_class, geom)
select distinct on (id) id, nullif(name, ''), nullif(highway_class, ''), geom
  from road_import
 order by id;
commit;
SQL

ROWS="$(psql "$DATABASE_URL" -tAc 'select count(*) from road_network;')"
say "road_network: $ROWS ways"
psql "$DATABASE_URL" -tAc "
  select highway_class || ' ' || count(*)
    from road_network group by highway_class order by count(*) desc limit 8;"

# -- 5 - serve ----------------------------------------------------------------------------------
if [ -n "$SKIP_SERVE" ]; then
  say "SKIP_SERVE set - start it yourself with: docker compose --profile routing up -d osrm"
  exit 0
fi

# Pinned so the container has the same name and network whether this runs from the repo root or
# from a git worktree. The bind mount is `./data` relative to the compose file, which is what makes
# the graph this script just built the graph the server loads.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-saakshi}"
export OSRM_HOST_PORT="${OSRM_HOST_PORT:-5000}"

# **macOS publishes :5000 to the AirPlay Receiver.** `ControlCenter` binds `*:5000` on both stacks,
# so Docker cannot take the port and `docker compose up` fails with `address already in use` after
# everything else has succeeded. Say so here, by name, instead of leaving it to be rediscovered.
if [ "$OSRM_HOST_PORT" = "5000" ] && command -v lsof >/dev/null 2>&1; then
  holder="$(lsof -nP -iTCP:5000 -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | head -1 || true)"
  if [ -n "$holder" ]; then
    echo ""
    echo "!! port 5000 is already held by '$holder'." >&2
    # `lsof -Fc` prints the full command name (`ControlCenter`), not the 9-character `ps` form
    # (`ControlCe`) — matching the truncated one silently skips the only hint that matters.
    if [ "$holder" = "ControlCenter" ]; then
      echo "   That is the macOS AirPlay Receiver. Either turn it off in" >&2
      echo "   System Settings > General > AirDrop & Handoff > AirPlay Receiver," >&2
      echo "   or re-run with a different host port, e.g. OSRM_HOST_PORT=5050." >&2
    fi
    echo "   The routing graph and road_network are already built; only serving is blocked." >&2
    exit 1
  fi
fi

say "starting the osrm service on host port $OSRM_HOST_PORT"
docker compose -f "$ROOT/docker-compose.yml" --profile routing up -d osrm

PROBE="http://localhost:$OSRM_HOST_PORT/route/v1/driving/72.6,23.2;72.65,23.25?overview=false"
printf '   waiting for OSRM'
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "$PROBE" >/dev/null 2>&1; then
    printf ' ok\n'
    curl -fsS "$PROBE" | jq '{code, duration: .routes[0].duration, distance: .routes[0].distance}'
    exit 0
  fi
  printf '.'
  sleep 2
done
printf '\n'
echo "OSRM did not answer within 120 s - 'docker compose --profile routing logs osrm'" >&2
exit 1
