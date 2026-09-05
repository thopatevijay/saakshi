# The basemap — reproducing the Gujarat extract

SAAKSHI serves its own map tiles. There is **no external tile API at runtime**: the console has to
work on an isolated police network, and a vendor tile key is a dependency a police deployment should
not carry — it is a third party that learns which places an investigation is looking at, an account
that can be suspended, and a recurring bill. This document is how the tiles get made.

The whole thing is one script, needing the internet **once**:

```bash
./scripts/build-basemap.sh              # newest available planet build, z0–12
./scripts/build-basemap.sh 20260904     # a specific build date
FORCE=1 ./scripts/build-basemap.sh      # rebuild over an existing extract
BBOX=68.0,19.9,74.6,24.8 MAXZOOM=13 ./scripts/build-basemap.sh
```

## What it produces

| Path | What | Size |
|---|---|---|
| `data/gujarat.pmtiles` | Vector tiles, z0–z12, Gujarat only | **28 MB** (29,781,693 bytes) |
| `data/basemap-fonts/Noto_Sans_Regular/{0-255,256-511}.pbf` | Label glyphs, Latin + Latin Extended-A | 199 kB |
| `data/basemap-fonts/Noto_Sans_Medium/{0-255,256-511}.pbf` | Label glyphs, medium weight | 203 kB |
| `data/.tools/pmtiles` | The `go-pmtiles` binary the script fetched | — |

All of it is under `data/`, which is **gitignored**. These are build outputs, not source: 28 MB of
binary in git would be paid for on every clone forever, and the file is reproducible from one
command.

Recorded from the extract in use:

```
$ data/.tools/pmtiles show data/gujarat.pmtiles
pmtiles spec version: 3
tile type: mvt
bounds: (long: 68.000000, lat: 19.900000) (long: 74.600000, lat: 24.800000)
min zoom: 0
max zoom: 12
addressed tiles count: 6315
tile entries count: 4963
tile contents count: 4739
clustered: true
version 4.15.2                                  ← Protomaps basemap schema
planetiler:osm:osmosisreplicationtime 2026-09-04T04:00:00Z
attribution © OpenStreetMap
```

## Where it comes from

The [Protomaps](https://protomaps.com) daily planet build — a single PMTiles file built by
[planetiler](https://github.com/onthegomap/planetiler) from OpenStreetMap, published under **ODbL**.
`pmtiles extract` reads it over **HTTP range requests**, so the script downloads only the tiles that
cover the Gujarat bounding box rather than a ~120 GB planet.

The bounding box is `68.0,19.9,74.6,24.8` — Gujarat spans roughly 68.16–74.47 °E and 20.06–24.71 °N,
padded so a pan to the edge does not hit empty space. It is written in the
`minLon,minLat,maxLon,maxLat` order that MapLibre, GeoJSON and the registry API's own `bbox` filter
all use, so the same string works everywhere.

Daily builds are retained for a limited window, so the script **resolves the newest build that
actually exists** rather than hardcoding a date that 404s next month. Pass a date to pin one.

## The glyphs, and why they are here

MapLibre renders labels from signed-distance-field glyph ranges, and its **default is to fetch them
from a CDN**. Self-hosting the tiles and then letting the labels phone home would defeat the whole
exercise — and it is invisible until a symbol layer renders, which is not when anyone is looking at
the network tab. So the script vendors two ranges per font stack:

- `0-255` — Latin
- `256-511` — Latin Extended-A, which covers the transliterated place names

The style names `/basemap/fonts/{fontstack}/{range}.pbf` explicitly. `basemap-style.test.ts` asserts
that every URL anywhere in the style tree is relative, and `verify-basemap.mjs` asserts the same
thing from the other side, by watching the real network.

Gujarati and Devanagari names in the extract are **not** rendered: those glyph ranges are not
vendored, and a box of tofu is worse than a transliteration. Every label layer therefore reads
`name:en` with `name` as the fallback. Adding Devanagari means vendoring the corresponding ranges
and the `pgf:name:hi` field the Protomaps schema carries.

## How the app serves it

`packages/web/app/basemap/[...asset]/route.ts`, a Node route handler:

- `GET /basemap/gujarat.pmtiles` — **with `Range` support**, which is not optional. PMTiles is one
  file with an internal directory, and the client reads it in byte ranges: a few kB of header, a
  directory page, then the handful of tiles the viewport needs. A handler that ignores `Range` makes
  the browser pull all 28 MB to draw one tile.
- `GET /basemap/fonts/{stack}/{range}.pbf` — the vendored glyphs.

Both are inside `middleware.ts`'s matcher, so an anonymous request is redirected to the login screen
rather than handed the estate's basemap. Path resolution is an allow-list with a re-check that the
resolved file is inside `data/`; a request for `fonts/../../etc/passwd` gets a 404.

The handler finds `data/` from `PMTILES_PATH` if set, otherwise by walking up from the working
directory — `next dev` runs in `packages/web`, `next start` may run from the repo root, and a
hardcoded relative path is correct in exactly one of those.

## MapLibre is pinned to v5, deliberately

MapLibre **6** loads its tile worker from a separate file resolved with
`new URL('./maplibre-gl-worker.mjs', import.meta.url)`. Under webpack — which `next build` uses —
`import.meta.url` is not an `http(s):` URL, so MapLibre's own guard returns `''`, and
`new Worker('')` resolves against the *document*: it fetches `/registry`, gets HTML, and fails with
`Failed to load module script … MIME type "text/html"`.

The failure mode is what makes this worth writing down. The map constructs, the canvas appears, the
style's sources resolve on the main thread, `map.on('error')` fires **nothing** — and the map is
simply blank, because every tile is parsed in a worker that never started. Pointing `setWorkerUrl`
at a webpack-emitted asset gets the worker to load and then fails one level deeper, because the
worker's own relative import of `maplibre-gl-shared.mjs` is not emitted beside it.

MapLibre 5 bundles the worker and creates it from a blob, so there is nothing to resolve and nothing
to vendor. Moving to 6 needs a copy step into `public/` that a fresh clone must remember to run — a
build dependency whose failure is an invisible blank map.

## Verifying it

Everything below is a committed script, so the claims stay re-runnable. They need the API and the
web app up, and a bearer token in a file.

```bash
# one terminal
DATABASE_URL=postgres://saakshi:saakshi@localhost:5432/saakshi npx tsx packages/api/src/index.ts
# another
npm run build -w packages/web && (cd packages/web && npx next start --port 3100)

# a token
curl -s -X POST http://localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"badgeNo":"GP-ADM-0001","password":"saakshi-dev"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))" > /tmp/token

# verify-map and verify-drawer take the API URL as a third argument, and it has to be passed:
# they default it to 4100 while the API above listens on 4000, so omitting it fails with
# ECONNREFUSED 127.0.0.1:4100. The others only ever talk to the web app.
cd packages/web
node scripts/verify-basemap.mjs    /tmp/token   # zero external requests
node scripts/verify-onboarding.mjs /tmp/token   # bulk import + row-level errors
DATABASE_URL=… node scripts/verify-roundtrip.mjs /tmp/token   # export → re-import
DATABASE_URL=… node scripts/bench-dashboard.mjs  /tmp/token   # seeds 100k, measures, cleans up
DATABASE_URL=… node scripts/verify-map.mjs    /tmp/token http://localhost:3100 http://localhost:4000  # coordinates vs PostGIS, filters, colours, pan
node scripts/verify-drawer.mjs                /tmp/token http://localhost:3100 http://localhost:4000  # the full trust breakdown
```

`verify-map.mjs` **seeds its own placed cameras** (D2-09). The Sentinel catalogue publishes no
coordinates, so without them four of its checks — clustering, street-zoom pins, the filter, and
filter restoration from the URL — have nothing to assert against and fail on every run. It inserts
sixteen fixtures under the reserved `MAPFIX-` prefix, asserts the render against known numbers, and
deletes them again, including when it fails part way. `VERIFY_MAP_CRASH=1` proves that last part.
The camera row count and the "without coordinates" count are asserted identical before and after; no
real camera is ever given a coordinate.

## Measured numbers

Recorded 2026-09-04 on an Apple Silicon laptop, headless Chrome with **software WebGL**
(SwiftShader — no GPU), against a local API and Postgres. **The machine was under concurrent load**:
D1-09's video pipeline was running eight decoders plus YOLO inference on the same host. Real numbers
on a quiet machine and a real GPU will be better; these are the pessimistic end.

### Cold dashboard load — `bench-dashboard.mjs`, 100,000 cameras

| Run | TTFB | FCP | DOMContentLoaded | load | map idle | transferred |
|---|---|---|---|---|---|---|
| 1 | 16 ms | 44 ms | 190 ms | 192 ms | 1651 ms | 733 kB |
| 2 | 4 ms | 64 ms | 131 ms | 132 ms | 1639 ms | 733 kB |
| 3 | 4 ms | 56 ms | 127 ms | 128 ms | 3219 ms | 733 kB |
| **median** | **4 ms** | **56 ms** | **131 ms** | **132 ms** | **1651 ms** | **733 kB** |

Target: **< 3 s**. The page is loaded and readable at **132 ms**, and the map has finished drawing
every tile and pin at **1.65 s**. Both are reported because they are different claims — a page that
is interactive at 132 ms with a map still painting is not the same as a blank screen for 1.6 s, and
folding them together in either direction would mislead.

Each run is genuinely cold: a fresh browser profile, HTTP cache disabled, first navigation. The
API's connection pool is *not* reset, because a police console is a long-running server and
benchmarking a cold database measures the deploy rather than the product.

**The map draws 2,000 of the 100,000.** `MAX_MAP_FEATURES` caps how many features the client holds,
and the header says so on screen — *"capped at 2000 — zoom in to load the rest"*. A legend silently
showing 2,000 of 100,000 would be a lie about coverage, and coverage is what this screen exists to
report on. Zooming narrows the `bbox` and the cap stops binding.

### Pan smoothness — `verify-map.mjs`

A five-leg programmatic sweep across Gujarat at z9, frame times sampled with `requestAnimationFrame`:

```
182 frames · p50 28 ms · p95 39.2 ms · worst 47.5 ms · 0 frames over 50 ms
```

Under software rasterisation with no GPU. 50 ms is the threshold below which a pan reads as
continuous rather than stepped, so passing here is a floor.

### Basemap isolation — `verify-basemap.mjs`

```
52 requests over load + 3 viewport changes
  localhost:3100    48
✓ every request went to localhost:3100 — no external host was contacted
19 range reads against /basemap/gujarat.pmtiles · 1 glyph range
```
