/**
 * The basemap style — hand-written, and **entirely self-hosted**.
 *
 * ## Why there is no tile API here
 *
 * The console has to work on an isolated police network, and a vendor tile key is a dependency a
 * police deployment should not carry: it is a third party that learns which places an investigation
 * is looking at, an account that can be suspended, and a bill. So the vector tiles are a PMTiles
 * extract of Gujarat served by this app's own route handler, and the label glyphs are vendored
 * next to them. **Every URL in the object this module returns is relative.** That is the acceptance
 * criterion, and `basemap-style.test.ts` asserts it by walking the whole style tree for anything
 * matching `^https?:` or `//` — including the trap that costs everyone a day, MapLibre's default
 * `glyphs` pointing at a CDN.
 *
 * ## Why not `protomaps-themes-base`
 *
 * It would work, and it would be one more dependency shipping several hundred layers of styling
 * for a map whose entire job is to be a quiet ground under camera pins. Fifteen layers, written
 * here, in the app's own slate palette, with no version to keep in step with the tileset.
 *
 * Layer names and fields come from the extract's own metadata (Protomaps basemap v4):
 * `earth · landcover · landuse · water · roads · boundaries · places`.
 */

/** Where the app serves the extract and the glyphs from. Relative on purpose — see above. */
export const BASEMAP_TILES_URL = '/basemap/gujarat.pmtiles';
export const BASEMAP_GLYPHS_URL = '/basemap/fonts/{fontstack}/{range}.pbf';

/** Gujarat, padded — the same box `scripts/build-basemap.sh` extracts. */
export const GUJARAT_BOUNDS: [number, number, number, number] = [68.0, 19.9, 74.6, 24.8];
export const GUJARAT_CENTER: [number, number] = [71.7, 22.4];
export const GUJARAT_ZOOM = 6.2;
/** The extract stops at z12; asking for z13 tiles would be 404s, not detail. */
export const BASEMAP_MAX_ZOOM = 12;

const INK = {
  earth: '#0b1220',
  land: '#111c2e',
  green: '#132437',
  water: '#0a2233',
  waterLine: '#164e63',
  roadMinor: '#1e2f47',
  roadMajor: '#2b405e',
  motorway: '#3b5474',
  border: '#33507a',
  borderDisputed: '#7c5a3a',
  label: '#8fa6c4',
  labelHalo: '#050a14',
} as const;

const FONT = ['Noto Sans Regular'];
const FONT_MEDIUM = ['Noto Sans Medium'];

/**
 * A complete MapLibre style. Plain JSON — no MapLibre import — so the test can walk it in Node
 * without a WebGL context.
 */
export function basemapStyle(): Record<string, unknown> {
  return {
    version: 8,
    name: 'SAAKSHI Gujarat (self-hosted)',
    // MapLibre falls back to a CDN when this is absent. Naming it is the whole point.
    glyphs: BASEMAP_GLYPHS_URL,
    sources: {
      basemap: {
        type: 'vector',
        // The `pmtiles://` protocol is registered on the MapLibre instance by the map component;
        // the path behind it is served by this app.
        url: `pmtiles://${BASEMAP_TILES_URL}`,
        attribution: '© OpenStreetMap contributors (ODbL) · Protomaps',
      },
    },
    // No sprite: nothing in this style uses an icon, and a sprite URL would be one more asset to
    // serve and one more chance to reach a CDN by accident.
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': INK.earth } },
      {
        id: 'earth',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'earth',
        paint: { 'fill-color': INK.land },
      },
      {
        id: 'landcover',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landcover',
        maxzoom: 8,
        paint: { 'fill-color': INK.green, 'fill-opacity': 0.5 },
      },
      {
        id: 'landuse',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landuse',
        minzoom: 6,
        filter: ['in', ['get', 'kind'], ['literal', ['park', 'forest', 'wood', 'nature_reserve']]],
        paint: { 'fill-color': INK.green, 'fill-opacity': 0.6 },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'water',
        paint: { 'fill-color': INK.water },
      },
      {
        id: 'water-line',
        type: 'line',
        source: 'basemap',
        'source-layer': 'water',
        minzoom: 7,
        paint: { 'line-color': INK.waterLine, 'line-width': 0.6, 'line-opacity': 0.7 },
      },
      {
        id: 'roads-minor',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        minzoom: 9,
        filter: ['in', ['get', 'kind'], ['literal', ['minor_road', 'other', 'path']]],
        paint: {
          'line-color': INK.roadMinor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.3, 12, 1.2],
        },
      },
      {
        id: 'roads-medium',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        minzoom: 6,
        filter: ['==', ['get', 'kind'], 'medium_road'],
        paint: {
          'line-color': INK.roadMajor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 2],
        },
      },
      {
        id: 'roads-major',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        minzoom: 4,
        filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]],
        paint: {
          'line-color': INK.motorway,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 8, 1.4, 12, 3],
        },
      },
      {
        id: 'boundaries-country',
        type: 'line',
        source: 'basemap',
        'source-layer': 'boundaries',
        filter: ['<=', ['get', 'kind_detail'], 2],
        paint: { 'line-color': INK.border, 'line-width': 1.2, 'line-opacity': 0.9 },
      },
      {
        id: 'boundaries-state',
        type: 'line',
        source: 'basemap',
        'source-layer': 'boundaries',
        filter: ['>', ['get', 'kind_detail'], 2],
        paint: {
          'line-color': INK.border,
          'line-width': 0.6,
          'line-opacity': 0.6,
          'line-dasharray': [3, 2],
        },
      },
      {
        // Rendered rather than hidden: a boundary the map quietly picks a side on is a claim the
        // map should not be making.
        id: 'boundaries-disputed',
        type: 'line',
        source: 'basemap',
        'source-layer': 'boundaries',
        filter: ['==', ['get', 'disputed'], true],
        paint: {
          'line-color': INK.borderDisputed,
          'line-width': 1,
          'line-dasharray': [1, 2],
        },
      },
      {
        id: 'place-city',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'places',
        filter: ['in', ['get', 'kind'], ['literal', ['locality', 'region', 'country']]],
        layout: {
          // `name:en` first: the extract carries Gujarati and Devanagari names the vendored Latin
          // glyph ranges cannot draw, and a box of tofu is worse than a transliteration.
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': FONT_MEDIUM,
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 14],
          'text-max-width': 8,
          'text-padding': 6,
        },
        paint: {
          'text-color': INK.label,
          'text-halo-color': INK.labelHalo,
          'text-halo-width': 1.4,
        },
      },
      {
        id: 'place-neighbourhood',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'places',
        minzoom: 11,
        filter: ['==', ['get', 'kind'], 'neighbourhood'],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': FONT,
          'text-size': 10,
          'text-padding': 4,
        },
        paint: {
          'text-color': INK.label,
          'text-halo-color': INK.labelHalo,
          'text-halo-width': 1.2,
          'text-opacity': 0.75,
        },
      },
    ],
  };
}

/**
 * Every URL-ish string in a style object, flattened.
 *
 * Used by the test that proves nothing external is referenced. It walks the whole tree rather than
 * checking the three keys we happen to remember, because the failure mode is a URL somewhere nobody
 * looked.
 */
export function collectStyleUrls(style: unknown, seen: string[] = []): string[] {
  if (typeof style === 'string') {
    if (
      style.startsWith('http://') ||
      style.startsWith('https://') ||
      style.startsWith('//') ||
      style.startsWith('pmtiles://') ||
      style.startsWith('/')
    ) {
      seen.push(style);
    }
    return seen;
  }
  if (Array.isArray(style)) {
    for (const item of style) collectStyleUrls(item, seen);
    return seen;
  }
  if (style !== null && typeof style === 'object') {
    for (const value of Object.values(style)) collectStyleUrls(value, seen);
    return seen;
  }
  return seen;
}

/** Does this URL leave the app's own origin? `pmtiles://` unwraps to the path behind it. */
export function isExternalUrl(url: string): boolean {
  const bare = url.startsWith('pmtiles://') ? url.slice('pmtiles://'.length) : url;
  return bare.startsWith('http://') || bare.startsWith('https://') || bare.startsWith('//');
}
