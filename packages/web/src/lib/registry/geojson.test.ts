/**
 * The partition that keeps the estate honest.
 *
 * The seeded estate splits in a way the map cannot paper over: thirty cameras with **measured**
 * trust scores and no coordinates, fifty with real coordinates and no score. Dropping either set
 * misrepresents the estate, so `partition` returns both and the screen renders both. These tests
 * pin that behaviour — including the one that matters most, that an unplaced camera is *counted*
 * rather than lost.
 */
import { describe, expect, it } from 'vitest';
import {
  countByBand,
  isPlaced,
  partition,
  toFeatureCollection,
  type MappableCamera,
} from './geojson';

const cam = (over: Partial<MappableCamera> = {}): MappableCamera => ({
  id: '11111111-1111-4111-8111-111111111111',
  externalId: 'cam01',
  name: 'Camera 1',
  lat: 23.0225,
  lon: 72.5714,
  district: 'Ahmedabad',
  departmentId: null,
  departmentCode: null,
  cameraType: 'ip',
  mount: 'static',
  adapterKind: 'hls',
  status: 'unknown',
  catalogueStatus: 'active',
  trustScore: 96.23,
  band: 'trusted',
  ...over,
});

describe('placement', () => {
  it('needs both coordinates', () => {
    expect(isPlaced(cam())).toBe(true);
    expect(isPlaced(cam({ lat: null, lon: null }))).toBe(false);
    expect(isPlaced(cam({ lat: null }))).toBe(false);
    expect(isPlaced(cam({ lon: null }))).toBe(false);
    expect(isPlaced(cam({ lat: Number.NaN }))).toBe(false);
  });

  it('splits the estate without losing a camera', () => {
    const estate = [
      cam({ id: 'a', externalId: 'GJ-AHM-001' }),
      cam({ id: 'b', externalId: 'cam01', lat: null, lon: null, band: 'trusted' }),
      cam({ id: 'c', externalId: 'cam02', lat: null, lon: null, band: 'degraded' }),
    ];
    const { placed, unplaced } = partition(estate);
    expect(placed.map((c) => c.id)).toEqual(['a']);
    expect(unplaced.map((c) => c.id)).toEqual(['b', 'c']);
    expect(placed.length + unplaced.length).toBe(estate.length);
  });

  it('keeps an unplaced camera`s real band, so the tray can colour it honestly', () => {
    const { unplaced } = partition([cam({ lat: null, lon: null, band: 'untrusted' })]);
    expect(unplaced[0].band).toBe('untrusted');
  });
});

describe('features', () => {
  it('emits [lon, lat] — the GeoJSON order the API`s bbox also uses', () => {
    const fc = toFeatureCollection([cam({ lat: 23.0225, lon: 72.5714 })]);
    expect(fc.features[0].geometry.coordinates).toEqual([72.5714, 23.0225]);
  });

  it('copies the API band verbatim and never recomputes it from the score', () => {
    // The case that catches a client-side threshold: a high score with a dead band. The API says
    // dead because the last probe could not connect; arithmetic on 96.23 would say trusted.
    const fc = toFeatureCollection([cam({ trustScore: 96.23, band: 'dead' })]);
    expect(fc.features[0].properties.band).toBe('dead');
    expect(fc.features[0].properties.trustScore).toBe(96.23);
  });

  it('renders a never-probed camera as `unscored`, not as a band', () => {
    const fc = toFeatureCollection([cam({ trustScore: null, band: null })]);
    expect(fc.features[0].properties.band).toBe('unscored');
    expect(fc.features[0].properties.trustScore).toBeNull();
  });

  it('carries presence and health as two separate properties', () => {
    const props = toFeatureCollection([cam({ catalogueStatus: 'absent', status: 'online' })])
      .features[0].properties;
    expect(props.catalogueStatus).toBe('absent');
    expect(props.status).toBe('online');
  });

  it('skips unplaced cameras rather than drawing them at null island', () => {
    const fc = toFeatureCollection([cam({ id: 'a' }), cam({ id: 'b', lat: null, lon: null })]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features.every((f) => f.geometry.coordinates[0] !== 0)).toBe(true);
  });

  it('uses the camera id as the feature id, so a selection survives a refetch', () => {
    const fc = toFeatureCollection([cam({ id: 'abc' })]);
    expect(fc.features[0].id).toBe('abc');
  });
});

describe('band counts', () => {
  it('counts null as unscored and the rest by their API band', () => {
    const counts = countByBand([
      cam({ band: 'trusted' }),
      cam({ band: 'trusted' }),
      cam({ band: 'degraded' }),
      cam({ band: null, trustScore: null }),
    ]);
    expect(counts).toEqual({ trusted: 2, degraded: 1, unscored: 1 });
  });

  it('is empty for an empty estate rather than a row of zeroes', () => {
    expect(countByBand([])).toEqual({});
  });
});
