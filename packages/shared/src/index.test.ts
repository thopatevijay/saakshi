import { describe, expect, it } from 'vitest';
import { Alert, AlertRecord, CameraConfig, Sighting } from './index.js';

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

describe('AlertRecord', () => {
  /**
   * The shape D2-06 actually emits and D2-07 renders. Rebuilt here rather than trimmed, because the
   * pre-D2-06 `Alert` was a sketch: it had no `lastSeenAt`, no `sightingCount`, and a `reason` with
   * seven flat fields. The why-payload the ticket requires — the camera, the sighting's PTS, the
   * crop, the matched record, and every ceiling that moved the severity — did not fit in it.
   */
  const reason = {
    matchType: 'fuzzy' as const,
    // Continuous under D2-04's weighted metric. An integer here would pass against the column
    // 0016 replaced.
    matchDistance: 0.7,
    explanation: 'Z→2 at position 7 — confusable pair at this blur level',
    identification: {
      observedPlate: 'GJ01AB1Z34',
      correctedPlate: 'GJ01AB1234',
      watchlistValue: 'GJ01AB1234',
      validity: 'valid' as const,
      grammarValid: true,
      grammarCorrected: true,
      rejectionCodes: [],
      missingChars: 0,
      completeness: 1,
      plateConfidence: 0.74,
      adjustedPlateConfidence: 0.666,
      matchConfidence: 0.82,
      combinedConfidence: 0.546,
      strength: 'probable' as const,
    },
    severityBasis: {
      fromCategory: 'high' as const,
      fromEntry: 'high' as const,
      ceilingsApplied: ['combined-below-55'],
      final: 'medium' as const,
      categoryRank: 2,
    },
    camera: {
      id: '00000000-0000-4000-8000-000000000003',
      externalId: 'cam12',
      name: '12 Tri Mandir Adalaj Tollnaka',
      location: { lat: 23.1, lon: 72.5 },
      district: 'Gandhinagar',
      trustScore: 68,
    },
    sighting: {
      id: '00000000-0000-4000-8000-000000000002',
      ts: '2026-06-14T03:15:22.000Z',
      framePtsMs: 4000,
      trackId: 900001,
      vehicleClass: 'car',
    },
    evidence: {
      cropUri: 's3://saakshi-evidence/evidence/cam12/2026-06-14/x-plate.jpg',
      cropUrl: 'http://localhost:9000/signed',
      cropUrlExpiresInS: 900,
      isBestShot: true,
    },
    watchlistRecord: {
      entryId: '00000000-0000-4000-8000-000000000001',
      category: 'stolen_vehicle' as const,
      entityType: 'vehicle' as const,
      plateNormalized: 'GJ01AB1234',
      personRef: null,
      sourceSystem: 'manual' as const,
      sourceRef: 'FIR/2026/001',
      providerSystem: 'manual' as const,
      live: false as const,
      entrySeverity: 'high' as const,
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
      note: null,
    },
    caveats: ['FUZZY MATCH — a ranked possibility, not an identification.'],
    disclaimer: 'MOCK PROVIDERS — SAAKSHI has no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS.',
    policyVersion: 1,
  };

  const base = {
    id: '00000000-0000-4000-8000-00000000000a',
    watchlistEntryId: '00000000-0000-4000-8000-000000000001',
    sightingId: '00000000-0000-4000-8000-000000000002',
    cameraId: '00000000-0000-4000-8000-000000000003',
    ts: '2026-06-14T03:15:22.000Z',
    lastSeenAt: '2026-06-14T03:19:02.000Z',
    sightingCount: 4,
    lastObservedPlate: 'GJ01AB1Z34',
    category: 'stolen_vehicle' as const,
    sourceSystem: 'manual' as const,
    severity: 'medium' as const,
    matchType: 'fuzzy' as const,
    matchDistance: 0.7,
    confidence: 0.546,
    reason,
    dedupeKey: '00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000003',
    dedupeWindowStart: '2026-06-14T03:10:00.000Z',
    status: 'new' as const,
    ackedBy: null,
    ackedAt: null,
    statusChangedBy: null,
    statusChangedAt: null,
    createdAt: '2026-06-14T03:15:23.000Z',
  };

  it('carries its own why-payload and starts unacknowledged', () => {
    const parsed = AlertRecord.parse(base);
    expect(parsed.status).toBe('new');
    expect(parsed.ackedBy).toBeNull();
    // Continuous, not rounded — the whole point of 0016's numeric column.
    expect(parsed.reason.matchDistance).toBe(0.7);
    expect(parsed.sightingCount).toBe(4);
  });

  it('never lets a provider claim to be live', () => {
    const result = AlertRecord.safeParse({
      ...base,
      reason: { ...reason, watchlistRecord: { ...reason.watchlistRecord, live: true } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a source system outside the specified connector set', () => {
    const result = AlertRecord.safeParse({ ...base, sourceSystem: 'SomeVendorCloud' });
    expect(result.success).toBe(false);
  });

  it('refuses an alert whose why-payload has lost its caveats', () => {
    const result = AlertRecord.safeParse({ ...base, reason: { ...reason, caveats: [] } });
    expect(result.success).toBe(false);
  });

  it('`Alert` is kept as an alias of `AlertRecord`, so one name means one shape', () => {
    expect(Alert).toBe(AlertRecord);
  });
});
