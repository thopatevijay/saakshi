#!/usr/bin/env bash
# Build data/gujarat.pmtiles — the self-hosted basemap.
#
# SAAKSHI serves its own vector tiles. There is no external tile API at runtime, because the
# console has to work on an isolated police network and because a vendor tile key is a dependency
# a police deployment should not carry. This script is the *build-time* step that produces the
# file; it needs the internet once, and never again.
#
# Source: the Protomaps daily planet build (© OpenStreetMap contributors, ODbL), extracted to the
# Gujarat bounding box over HTTP range requests — so it downloads the tiles that cover Gujarat
# rather than the whole planet.
#
# Usage:  ./scripts/build-basemap.sh [YYYYMMDD] [MAXZOOM]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/data/gujarat.pmtiles"
TOOLS="$ROOT/data/.tools"
PMTILES_VERSION="${PMTILES_VERSION:-1.31.2}"

# Gujarat spans roughly 68.16-74.47 E and 20.06-24.71 N. Padded, in the GeoJSON/MapLibre ordering
# (minLon,minLat,maxLon,maxLat) that the registry API's `bbox` filter also uses.
BBOX="${BBOX:-68.0,19.9,74.6,24.8}"
BUILD_DATE="${1:-}"
MAXZOOM="${2:-12}"

os="$(uname -s)"; arch="$(uname -m)"
case "$os/$arch" in
  Darwin/arm64)  asset="go-pmtiles-${PMTILES_VERSION}_Darwin_arm64.zip" ;;
  Darwin/x86_64) asset="go-pmtiles-${PMTILES_VERSION}_Darwin_x86_64.zip" ;;
  Linux/aarch64) asset="go-pmtiles_${PMTILES_VERSION}_Linux_arm64.tar.gz" ;;
  Linux/x86_64)  asset="go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" ;;
  *) echo "unsupported platform $os/$arch - download go-pmtiles by hand" >&2; exit 1 ;;
esac

mkdir -p "$TOOLS" "$ROOT/data"

if [ ! -x "$TOOLS/pmtiles" ]; then
  echo "-> fetching go-pmtiles $PMTILES_VERSION ($asset)"
  url="https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${asset}"
  curl -fsSL "$url" -o "$TOOLS/$asset"
  case "$asset" in
    *.zip)    unzip -oq "$TOOLS/$asset" -d "$TOOLS" ;;
    *.tar.gz) tar -xzf "$TOOLS/$asset" -C "$TOOLS" ;;
  esac
  chmod +x "$TOOLS/pmtiles"
fi

# The daily builds are keyed by date and retained for a limited window, so resolve the newest one
# that actually exists rather than hardcoding a date that will 404 next month.
if [ -z "$BUILD_DATE" ]; then
  echo "-> resolving the newest available planet build"
  for i in $(seq 0 40); do
    d="$(date -u -v-"${i}"d +%Y%m%d 2>/dev/null || date -u -d "-${i} days" +%Y%m%d)"
    code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -r 0-0 "https://build.protomaps.com/$d.pmtiles" || true)"
    if [ "$code" = "206" ] || [ "$code" = "200" ]; then BUILD_DATE="$d"; break; fi
  done
fi
[ -n "$BUILD_DATE" ] || { echo "no protomaps build found in the last 40 days" >&2; exit 1; }

if [ -f "$OUT" ] && [ -z "${FORCE:-}" ]; then
  echo "-> $OUT already exists (FORCE=1 to rebuild)"
else
  echo "-> extracting bbox $BBOX z0-$MAXZOOM from build $BUILD_DATE"
  "$TOOLS/pmtiles" extract "https://build.protomaps.com/${BUILD_DATE}.pmtiles" "$OUT" \
    --bbox="$BBOX" --maxzoom="$MAXZOOM"
fi

# Glyphs. MapLibre renders labels from signed-distance-field glyph ranges, and the default is to
# fetch them from a CDN — which would put an external request on the map after all the trouble of
# self-hosting the tiles. Vendored here and served by the app's own /basemap route instead.
# 0-255 covers Latin, 256-511 covers Latin Extended-A (the transliterated Gujarati place names).
echo "-> vendoring glyphs"
FONT_BASE="https://protomaps.github.io/basemaps-assets/fonts"
for stack in "Noto Sans Regular" "Noto Sans Medium"; do
  slug="$(echo "$stack" | tr ' ' '_')"
  mkdir -p "$ROOT/data/basemap-fonts/$slug"
  for range in 0-255 256-511; do
    target="$ROOT/data/basemap-fonts/$slug/$range.pbf"
    [ -s "$target" ] && continue
    encoded="$(echo "$stack" | sed 's/ /%20/g')"
    curl -fsSL "$FONT_BASE/$encoded/$range.pbf" -o "$target"
    echo "   $slug/$range.pbf $(wc -c < "$target" | tr -d ' ') bytes"
  done
done

echo "-> done"
"$TOOLS/pmtiles" show "$OUT" | head -20
ls -lh "$OUT"
