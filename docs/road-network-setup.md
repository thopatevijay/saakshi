# Road network setup — OSM, OSRM and `road_network`

Route reconstruction (D3-01), gap analysis (D3-06) and impossible-transition detection (D3-02) all
need the same thing: a road graph for Gujarat. One script builds it.

```bash
./scripts/import-osm.sh
```

That is the whole procedure on a machine that has Docker, `psql`, `jq` and `osmium`. It takes
roughly **12 minutes cold** and a few seconds warm, downloads ~220 MB once, and leaves an OSRM
server answering on `:5000` with `road_network` filled.

---

## What it produces, and which of the two things needs which

| output | who consumes it |
|---|---|
| `data/gujarat-latest.osrm*` — an OSRM MLD routing graph | `packages/api/src/services/osrm.ts`, over HTTP against the `osrm` container |
| `road_network` in PostGIS — 540,584 GiST-indexed ways | `camera_coverage.covered_road_ids`, D3-06's gap analysis |

They are two different representations of the same data and neither substitutes for the other. OSRM
answers *"how long should this journey take"*; PostGIS answers *"what roads are near this camera"*.

## Prerequisites

| tool | why | install |
|---|---|---|
| Docker | runs `osrm-extract` / `osrm-partition` / `osrm-customize` and the server | — |
| `osmium-tool` | clips the extract and exports way geometry | `brew install osmium-tool` · `apt-get install osmium-tool` |
| `jq`, `psql` | flattening GeoJSON to TSV, and `COPY` | — |

**`osmium-tool` is a native dependency, not a container**, and that is deliberate rather than
lazy: it has no public image. `ghcr.io/osmcode/osmium-tool` and every community mirror answer
`denied` to an unauthenticated pull (checked 2026-09-05). The script checks for the binary up front
and names the install command rather than failing four stages later.

## Where the data comes from

**Geofabrik publishes no standalone Gujarat extract.** The smallest region that contains Gujarat is
`asia/india/western-zone` — Gujarat, Maharashtra, Goa, Dadra & Nagar Haveli and Daman & Diu, about
220 MB. The script downloads that once and clips it to

```
68.0,19.9,74.6,24.8      # minLon,minLat,maxLon,maxLat
```

which is **byte-for-byte the bbox `scripts/build-basemap.sh` uses**, so the routing graph and the
vector tiles a route is drawn over cover exactly the same ground. The clipped file is written as
`data/gujarat-latest.osm.pbf`, which is the filename `docker-compose.yml`'s `osrm` service already
expected, so no compose change was needed for it.

Clipping uses `--strategy=complete_ways`, which keeps every way that touches the box whole including
the nodes outside it. Without that a highway crossing the state boundary is truncated mid-way and
OSRM cannot route along it — and the routes that break are exactly the long-distance ones an
interstate-movement question depends on.

© OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/). Same licence and
attribution as the basemap; the console credits it in the map's attribution control.

## Which roads are imported

```
motorway  motorway_link  trunk  trunk_link  primary  primary_link
secondary secondary_link tertiary tertiary_link unclassified residential
living_street road
```

Measured result on the 2026-09-04 extract:

| class | ways |
|---|---|
| residential | 420,160 |
| unclassified | 46,348 |
| tertiary | 36,708 |
| primary | 12,222 |
| trunk | 9,120 |
| secondary | 7,261 |
| living_street | 2,222 |
| trunk_link | 1,739 |
| **total** | **540,584** |

`service`, `track`, `path`, `footway` and `cycleway` are **excluded**. They are not where a number
plate gets read, they multiply the row count several-fold, and a coverage or gap-analysis percentage
computed over farm tracks and car-park aisles is not a percentage anyone should quote to a reviewer.
Override with `HIGHWAY_CLASSES=...` if a later ticket needs them.

`road_network.id` is the **OSM way id**, so a re-import reproduces the same primary keys and
`camera_coverage.covered_road_ids` does not rot between imports. The load goes through a staging
table and swaps in one transaction: a half-finished `COPY` can never leave the table holding a
subset of the roads, because a silently short road network makes every coverage figure quietly wrong
rather than obviously broken.

## Nothing is committed

`data/` is gitignored, and the extract, the clipped pbf, the `.osrm*` graph and the intermediate
GeoJSON come to well over a gigabyte. **A fresh clone therefore has no road graph**, and
`docker compose --profile routing up osrm` on such a checkout exits immediately with a missing-file
error. That is what this script and this page exist to fix. The API degrades honestly in the
meantime: with no graph reachable, every camera-to-camera hop comes back as `inferred_unroutable`
with the reason stated, and the trace itself is unaffected.

Each stage is skipped when its output is newer than its input, so a re-run after a failed database
import re-imports only. `FORCE=1` redoes everything.

## macOS: port 5000 is the AirPlay Receiver

`ControlCenter` binds `*:5000` on both IP stacks, so Docker cannot publish the port and
`docker compose up` fails with `address already in use` **after** the graph has been built. Two ways
out:

- turn it off — System Settings → General → AirDrop & Handoff → AirPlay Receiver; or
- move the port:

  ```bash
  OSRM_HOST_PORT=5050 ./scripts/import-osm.sh
  OSRM_URL=http://localhost:5050 npm run dev -w packages/api
  ```

`docker-compose.yml` reads `${OSRM_HOST_PORT:-5000}`, so **5000 remains the default** and a Linux
host or a Railway deployment needs nothing set. The script detects the collision before starting the
container and names the process holding the port.

## Verifying it

```bash
psql "$DATABASE_URL" -c "select count(*) from road_network;"
psql "$DATABASE_URL" -c "\di road_network*"          # road_network_geom_gix must be listed
curl -fsS "http://localhost:5000/route/v1/driving/72.6,23.2;72.65,23.25?overview=false" \
  | jq '.routes[0].duration'
```

The last one answered `731.7` seconds over `8730.9` metres on the 2026-09-04 graph — about 43 km/h
across central Ahmedabad, which is what a free-flow car profile with no traffic model should say.

## Troubleshooting

| symptom | cause |
|---|---|
| `jq: parse error: Invalid numeric literal at line 1, column 2` | `geojsonseq` prefixes each line with an RFC 7464 record separator. The script strips it with `tr -d '\036'`; jq's own `--seq` also *emits* one, which corrupts the TSV. |
| exit 139 from a stage, no message | a shell function shadowing the binary it calls — `osmium() { osmium ...; }` recurses until the stack blows and looks exactly like a segfault in libosmium. |
| `not a PBF file` | a Geofabrik `-latest` URL fetched without `-L`. The 302 body is a 252-byte HTML stub. |
| OSRM answers `NoRoute` for everything | `osrm-customize` never ran, or the container is serving a stale `.osrm`. `FORCE=1 ./scripts/import-osm.sh`. |
