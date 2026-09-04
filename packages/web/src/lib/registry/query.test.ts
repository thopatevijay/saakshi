/**
 * "Every layer toggle and filter works, composes with the others, and survives a page reload via
 * URL state."
 *
 * Survival across a reload is a **round-trip property**, so it is tested as one: build a state,
 * serialise it, parse it back, assert equality. A screenshot of a reloaded page proves one case;
 * this proves the shape.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMIT,
  bboxParam,
  emptyLayers,
  isVisible,
  parseFilters,
  parseLayers,
  parseRegistryState,
  toCameraListQuery,
  toSearchParams,
  toggleLayer,
  type RegistryState,
  type Visibility,
} from './query';

const camera = (over: Partial<Visibility> = {}): Visibility => ({
  band: 'trusted',
  cameraType: 'ip',
  mount: 'static',
  adapterKind: 'hls',
  status: 'unknown',
  departmentId: '11111111-1111-4111-8111-111111111111',
  ...over,
});

describe('filters parse against the D1-02 contract', () => {
  it('reads every published parameter', () => {
    const filters = parseFilters(
      new URLSearchParams({
        departmentId: '11111111-1111-4111-8111-111111111111',
        district: 'Ahmedabad',
        cameraType: 'ip',
        mount: 'mobile',
        adapterKind: 'rtsp',
        status: 'online',
        geometryClass: 'anpr_viable',
        trustMin: '40',
        trustMax: '90',
        bbox: '72.4,22.9,72.8,23.2',
        q: 'ring road',
        limit: '120',
      }),
    );

    expect(filters).toEqual({
      departmentId: '11111111-1111-4111-8111-111111111111',
      district: 'Ahmedabad',
      cameraType: 'ip',
      mount: 'mobile',
      adapterKind: 'rtsp',
      status: 'online',
      geometryClass: 'anpr_viable',
      trustMin: 40,
      trustMax: 90,
      bbox: '72.4,22.9,72.8,23.2',
      q: 'ring road',
      limit: 120,
    });
  });

  it('drops values outside the enum rather than forwarding them to the API', () => {
    const filters = parseFilters(
      new URLSearchParams({
        cameraType: 'thermal',
        adapterKind: 'carrier-pigeon',
        status: 'absent', // a real trap: `absent` is a *catalogue* status, not a health one
        departmentId: 'not-a-uuid',
      }),
    );
    expect(filters.cameraType).toBeUndefined();
    expect(filters.adapterKind).toBeUndefined();
    expect(filters.status).toBeUndefined();
    expect(filters.departmentId).toBeUndefined();
  });

  it('rejects an out-of-range trust bound and a malformed bbox', () => {
    expect(parseFilters(new URLSearchParams({ trustMin: '140' })).trustMin).toBeUndefined();
    expect(parseFilters(new URLSearchParams({ trustMax: '-3' })).trustMax).toBeUndefined();
    expect(parseFilters(new URLSearchParams({ bbox: '72.4,22.9,72.8' })).bbox).toBeUndefined();
  });

  it('clamps limit to the contract and defaults it', () => {
    expect(parseFilters(new URLSearchParams({ limit: '900' })).limit).toBe(DEFAULT_LIMIT);
    expect(parseFilters(new URLSearchParams({ limit: '0' })).limit).toBe(DEFAULT_LIMIT);
    expect(parseFilters(new URLSearchParams()).limit).toBe(DEFAULT_LIMIT);
    expect(parseFilters(new URLSearchParams({ limit: '25' })).limit).toBe(25);
  });

  it('accepts the plain object a Next server component receives', () => {
    expect(parseFilters({ district: 'Surat', cameraType: 'analog' })).toMatchObject({
      district: 'Surat',
      cameraType: 'analog',
    });
  });
});

describe('the query handed to the generated client is the contract, unrenamed', () => {
  it('passes filters straight through and omits what is unset', () => {
    const query = toCameraListQuery(parseFilters(new URLSearchParams({ district: 'Rajkot' })));
    expect(query).toEqual({ district: 'Rajkot', limit: DEFAULT_LIMIT });
  });

  it('carries an opaque cursor when one is supplied', () => {
    const query = toCameraListQuery(parseFilters(new URLSearchParams()), 'eyJhIjoxfQ');
    expect(query['cursor']).toBe('eyJhIjoxfQ');
  });

  it('never invents a key the API does not define', () => {
    const allowed = new Set([
      'departmentId',
      'district',
      'cameraType',
      'mount',
      'adapterKind',
      'status',
      'geometryClass',
      'trustMin',
      'trustMax',
      'bbox',
      'q',
      'cursor',
      'limit',
    ]);
    const query = toCameraListQuery(
      parseFilters(
        new URLSearchParams({
          district: 'Vadodara',
          trustMin: '70',
          bbox: '72,22,73,23',
          q: 'gate',
        }),
      ),
      'cur',
    );
    for (const key of Object.keys(query)) expect(allowed.has(key), key).toBe(true);
  });
});

describe('layer toggles', () => {
  it('reads a hidden set per dimension', () => {
    const layers = parseLayers(
      new URLSearchParams({
        hideBand: 'dead,unscored',
        hideType: 'analog',
        hideAdapter: 'nvr,file',
      }),
    );
    expect([...layers.band].sort()).toEqual(['dead', 'unscored']);
    expect([...layers.cameraType]).toEqual(['analog']);
    expect([...layers.adapterKind].sort()).toEqual(['file', 'nvr']);
    expect(layers.mount.size).toBe(0);
  });

  it('drops an unknown value so a typo cannot silently hide a camera', () => {
    const layers = parseLayers(new URLSearchParams({ hideBand: 'dead,sparkling,unscored' }));
    expect([...layers.band].sort()).toEqual(['dead', 'unscored']);
  });

  it('treats `unscored` as a first-class band, not as a low score', () => {
    // D1-02: `trustScore: null` matches neither trustMin nor trustMax. It is its own bucket, and
    // hiding `untrusted` must leave never-probed cameras on the map.
    const layers = parseLayers(new URLSearchParams({ hideBand: 'untrusted' }));
    expect(isVisible(camera({ band: null }), layers)).toBe(true);
    expect(isVisible(camera({ band: 'untrusted' }), layers)).toBe(false);
  });

  it('toggles without mutating the previous state', () => {
    const before = emptyLayers();
    const after = toggleLayer(before, 'band', 'dead');
    expect(before.band.size).toBe(0);
    expect([...after.band]).toEqual(['dead']);
    expect([...toggleLayer(after, 'band', 'dead').band]).toEqual([]);
  });
});

describe('toggles compose as AND across dimensions', () => {
  it('hides a camera matched by any one of them', () => {
    let layers = emptyLayers();
    layers = toggleLayer(layers, 'band', 'degraded');
    layers = toggleLayer(layers, 'adapterKind', 'nvr');
    layers = toggleLayer(layers, 'mount', 'mobile');

    expect(isVisible(camera(), layers)).toBe(true);
    expect(isVisible(camera({ band: 'degraded' }), layers)).toBe(false);
    expect(isVisible(camera({ adapterKind: 'nvr' }), layers)).toBe(false);
    expect(isVisible(camera({ mount: 'mobile' }), layers)).toBe(false);
    // Two reasons to hide is still hidden, not hidden twice and shown.
    expect(isVisible(camera({ band: 'degraded', mount: 'mobile' }), layers)).toBe(false);
  });

  it('hides by department without touching the department filter', () => {
    const dept = '22222222-2222-4222-8222-222222222222';
    const layers = toggleLayer(emptyLayers(), 'department', dept);
    expect(isVisible(camera({ departmentId: dept }), layers)).toBe(false);
    expect(isVisible(camera(), layers)).toBe(true);
    expect(isVisible(camera({ departmentId: null }), layers)).toBe(true);
  });
});

describe('URL round trip — the reload guarantee', () => {
  const states: [string, RegistryState][] = [
    [
      'empty',
      { filters: parseFilters(new URLSearchParams()), layers: emptyLayers(), selected: null },
    ],
    [
      'three filters and two toggles',
      {
        filters: parseFilters(
          new URLSearchParams({ district: 'Ahmedabad', adapterKind: 'hls', trustMin: '40' }),
        ),
        layers: (() => {
          let l = toggleLayer(emptyLayers(), 'band', 'unscored');
          l = toggleLayer(l, 'cameraType', 'analog');
          return l;
        })(),
        selected: null,
      },
    ],
    [
      'everything at once, drawer open',
      {
        filters: parseFilters(
          new URLSearchParams({
            departmentId: '11111111-1111-4111-8111-111111111111',
            district: 'Surat',
            cameraType: 'ip',
            mount: 'mobile',
            adapterKind: 'rtsp',
            status: 'online',
            geometryClass: 'anpr_viable',
            trustMin: '10',
            trustMax: '90',
            bbox: '72.4000,22.9000,72.8000,23.2000',
            q: 'flyover',
            limit: '250',
          }),
        ),
        layers: (() => {
          let l = toggleLayer(emptyLayers(), 'band', 'dead');
          l = toggleLayer(l, 'band', 'unscored');
          l = toggleLayer(l, 'mount', 'static');
          l = toggleLayer(l, 'status', 'offline');
          l = toggleLayer(l, 'department', '33333333-3333-4333-8333-333333333333');
          return l;
        })(),
        selected: '44444444-4444-4444-8444-444444444444',
      },
    ],
  ];

  it.each(states)('%s survives serialise → parse', (_name, state) => {
    const restored = parseRegistryState(toSearchParams(state));
    expect(restored.filters).toEqual(state.filters);
    expect(restored.selected).toEqual(state.selected);
    for (const key of Object.keys(state.layers) as (keyof typeof state.layers)[]) {
      expect([...restored.layers[key]].sort(), key).toEqual([...state.layers[key]].sort());
    }
  });

  it('leaves the default state with an empty query string', () => {
    const params = toSearchParams({
      filters: parseFilters(new URLSearchParams()),
      layers: emptyLayers(),
      selected: null,
    });
    expect(params.toString()).toBe('');
  });

  it('a filter and a toggle both land in the URL and neither erases the other', () => {
    const params = toSearchParams({
      filters: parseFilters(new URLSearchParams({ district: 'Bhuj' })),
      layers: toggleLayer(emptyLayers(), 'band', 'dead'),
      selected: null,
    });
    expect(params.get('district')).toBe('Bhuj');
    expect(params.get('hideBand')).toBe('dead');
  });
});

describe('bbox is emitted in the API ordering', () => {
  it('is minLon,minLat,maxLon,maxLat — longitude first', () => {
    const bounds = {
      getWest: () => 72.4123456,
      getSouth: () => 22.9123456,
      getEast: () => 72.8987654,
      getNorth: () => 23.2987654,
    };
    expect(bboxParam(bounds)).toBe('72.4123,22.9123,72.8988,23.2988');
    // Round-trips through the parser the API shares.
    expect(parseFilters(new URLSearchParams({ bbox: bboxParam(bounds) })).bbox).toBe(
      '72.4123,22.9123,72.8988,23.2988',
    );
  });
});
