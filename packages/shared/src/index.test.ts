import { describe, expect, it } from 'vitest';
import { Alert, CameraConfig, Sighting } from './index.js';

describe('CameraConfig', () => {
  it('accepts a minimal HLS camera and applies the untrusted-by-default fields', () => {
    const parsed = CameraConfig.parse({
      externalId: 'cam12',
      name: '12 Tri Mandir Adalaj Tollnaka',
      adapterKind: 'hls',
      endpoints: { hls: 'https://cctv.example/cam12/index.m3u8' },
    });

    expect(parsed.cameraType).toBe('ip');
    expect(parsed.geometry).toBe('unclassified');
    expect(parsed.status).toBe('unknown');
    expect(parsed.trustScore).toBeNull();
  });

  it('rejects a declared resolution that is not WIDTHxHEIGHT', () => {
    const result = CameraConfig.safeParse({
      externalId: 'cam01',
      name: '01 Chiman bhai Bridge',
      adapterKind: 'hls',
      endpoints: {},
      declaredResolution: '1080p',
    });

    expect(result.success).toBe(false);
  });
});

describe('Sighting', () => {
  it('requires a PTS and defaults the evidence fields', () => {
    const parsed = Sighting.parse({
      cameraId: 'cam12',
      ts: '2026-06-14T03:15:22.000Z',
      framePtsMs: 39_600_000,
      trackId: 7,
      class: 'car',
      bbox: { x: 120, y: 88, w: 210, h: 140 },
      detConfidence: 0.91,
    });

    expect(parsed.framePtsMs).toBe(39_600_000);
    expect(parsed.plateReads).toEqual([]);
    expect(parsed.cropUri).toBeNull();
  });

  it('rejects a detection confidence outside 0..1', () => {
    const result = Sighting.safeParse({
      cameraId: 'cam12',
      ts: '2026-06-14T03:15:22.000Z',
      framePtsMs: 0,
      trackId: 0,
      class: 'car',
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      detConfidence: 1.4,
    });

    expect(result.success).toBe(false);
  });
});

describe('Alert', () => {
  it('carries its own why-payload and starts unacknowledged', () => {
    const parsed = Alert.parse({
      watchlistEntryId: '00000000-0000-4000-8000-000000000001',
      sightingId: '00000000-0000-4000-8000-000000000002',
      cameraId: 'cam12',
      ts: '2026-06-14T03:15:22.000Z',
      category: 'stolen_vehicle',
      sourceSystem: 'manual',
      severity: 'high',
      confidence: 0.82,
      dedupeKey: 'cam12:GJ01AB1234:2026-06-14T03:15',
      reason: {
        matchType: 'fuzzy',
        matchDistance: 1,
        observedPlate: 'GJ01AB1Z34',
        watchlistPlate: 'GJ01AB1234',
        explanation: 'Z→2 at position 7 — confusable pair at this blur level',
        plateConfidence: 0.74,
        cameraTrustScore: 68,
      },
    });

    expect(parsed.status).toBe('new');
    expect(parsed.ackedBy).toBeNull();
    expect(parsed.reason.matchDistance).toBe(1);
  });

  it('rejects a source system outside the specified connector set', () => {
    const result = Alert.safeParse({
      watchlistEntryId: '00000000-0000-4000-8000-000000000001',
      sightingId: '00000000-0000-4000-8000-000000000002',
      cameraId: 'cam12',
      ts: '2026-06-14T03:15:22.000Z',
      category: 'stolen_vehicle',
      sourceSystem: 'SomeVendorCloud',
      severity: 'high',
      confidence: 0.8,
      dedupeKey: 'k',
      reason: {
        matchType: 'exact',
        matchDistance: 0,
        observedPlate: 'GJ01AB1234',
        watchlistPlate: 'GJ01AB1234',
        explanation: 'exact',
        plateConfidence: 0.9,
        cameraTrustScore: null,
      },
    });

    expect(result.success).toBe(false);
  });
});
