/**
 * "Basemap loads entirely from the local PMTiles file — network tab shows zero external tile
 * requests."
 *
 * The browser check is the proof (see `scripts/verify-basemap.mjs`), but a browser check only
 * covers the tiles the run happened to request. This walks the **whole style object** for anything
 * that could ever leave the origin — every string, at every depth — so a CDN URL added to a layer
 * nobody screenshots still fails the suite.
 *
 * The failure this is really guarding against is `glyphs`. Omit it and MapLibre reaches for a CDN
 * at the first label, which is a network request that appears only when a symbol layer renders, in
 * a place nobody thinks to look.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  BASEMAP_GLYPHS_URL,
  BASEMAP_MAX_ZOOM,
  BASEMAP_TILES_URL,
  GUJARAT_BOUNDS,
  basemapStyle,
  collectStyleUrls,
  isExternalUrl,
} from './basemap-style';

const style = basemapStyle();

describe('the style is self-hosted', () => {
  it('references no external host anywhere in the tree', () => {
    const urls = collectStyleUrls(style);
    expect(urls.length).toBeGreaterThan(0);
    const external = urls.filter(isExternalUrl);
    expect(external, `external URLs in the style: ${external.join(', ')}`).toEqual([]);
  });

  it('names a local glyphs URL — the CDN fallback MapLibre uses when this is absent', () => {
    expect(style['glyphs']).toBe(BASEMAP_GLYPHS_URL);
    expect(BASEMAP_GLYPHS_URL.startsWith('/')).toBe(true);
    expect(BASEMAP_GLYPHS_URL).toContain('{fontstack}');
    expect(BASEMAP_GLYPHS_URL).toContain('{range}');
  });

  it('points the vector source at the app-served extract over the pmtiles protocol', () => {
    const sources = style['sources'] as Record<string, { type: string; url: string }>;
    expect(sources['basemap'].type).toBe('vector');
    expect(sources['basemap'].url).toBe(`pmtiles://${BASEMAP_TILES_URL}`);
  });

  it('declares no sprite, so there is no icon atlas to fetch from anywhere', () => {
    expect(style['sprite']).toBeUndefined();
  });

  it('classifies a CDN URL as external even when wrapped in pmtiles://', () => {
    expect(isExternalUrl('https://demotiles.maplibre.org/style.json')).toBe(true);
    expect(isExternalUrl('pmtiles://https://build.protomaps.com/20260904.pmtiles')).toBe(true);
    expect(isExternalUrl('//fonts.example.com/a.pbf')).toBe(true);
    expect(isExternalUrl('/basemap/gujarat.pmtiles')).toBe(false);
    expect(isExternalUrl('pmtiles:///basemap/gujarat.pmtiles')).toBe(false);
  });
});

describe('the style renders something', () => {
  it('is a valid style version 8 with layers over the extract`s own source layers', () => {
    expect(style['version']).toBe(8);
    const layers = style['layers'] as { id: string; 'source-layer'?: string }[];
    expect(layers.length).toBeGreaterThanOrEqual(10);

    // Exactly the layer names the extract's metadata advertises. A typo here renders nothing and
    // reports no error, which is the worst kind of bug to find by eye.
    const available = new Set([
      'earth',
      'landcover',
      'landuse',
      'water',
      'roads',
      'boundaries',
      'places',
      'pois',
      'buildings',
    ]);
    for (const layer of layers) {
      if (layer['source-layer'] !== undefined) {
        expect(available.has(layer['source-layer']), layer.id).toBe(true);
      }
    }
  });

  it('gives every layer a unique id', () => {
    const ids = (style['layers'] as { id: string }[]).map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers Gujarat and stops at the zoom the extract actually holds', () => {
    const [west, south, east, north] = GUJARAT_BOUNDS;
    expect(west).toBeLessThan(east);
    expect(south).toBeLessThan(north);
    // Ahmedabad, Surat and Bhuj must all fall inside the box the pins will sit in.
    for (const [lon, lat] of [
      [72.5714, 23.0225],
      [72.8311, 21.1702],
      [69.6669, 23.242],
    ]) {
      expect(lon).toBeGreaterThan(west);
      expect(lon).toBeLessThan(east);
      expect(lat).toBeGreaterThan(south);
      expect(lat).toBeLessThan(north);
    }
    expect(BASEMAP_MAX_ZOOM).toBe(12);
  });
});

/**
 * The extract is gitignored, so this is a soft check: it asserts the file when a build has produced
 * it and says so when it has not, rather than failing a clean checkout that has never run
 * `scripts/build-basemap.sh`.
 */
describe('the extract on disk, when one has been built', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../../../..');
  const tiles = path.join(repoRoot, 'data', 'gujarat.pmtiles');

  it('is a non-trivial PMTiles file with the vendored glyph ranges beside it', () => {
    if (!existsSync(tiles)) {
      expect(existsSync(path.join(repoRoot, 'scripts', 'build-basemap.sh'))).toBe(true);
      return;
    }
    expect(statSync(tiles).size).toBeGreaterThan(1_000_000);
    for (const stack of ['Noto_Sans_Regular', 'Noto_Sans_Medium']) {
      for (const range of ['0-255.pbf', '256-511.pbf']) {
        const glyph = path.join(repoRoot, 'data', 'basemap-fonts', stack, range);
        expect(existsSync(glyph), glyph).toBe(true);
      }
    }
  });
});
