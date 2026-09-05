/**
 * D3-02 — impossible-transition detection, and the misread-versus-clone question.
 *
 * Pure arithmetic throughout: no Postgres, no OSRM, no network. Feasibility and disambiguation are
 * functions of a segment and two sightings, so the acceptance criteria about *behaviour* are all
 * assertable on any machine, and a regression in the physics fails here rather than in a gate.
 *
 * The OCR confidences are not invented. `0.449`, `0.503`, `0.56`, `0.627` and `0.732` are the five
 * legible plate reads the live estate actually produced (D2-01, `config/alert-policy.json`), and
 * `0.88` / `0.83` are the fixture itinerary's confident reads. AC 4 asks for both branches covered
 * *"using real low-confidence and high-confidence reads"*, so those are the numbers used.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeRetention } from '@saakshi/shared';
import {
  ANOMALY_COPY,
  analyseRoute,
  assessFeasibility,
  candidateFor,
  disambiguate,
  loadAnomalyPolicy,
  type AnomalyPolicy,
} from './anomaly.js';
import { loadConfusions } from './plate-search.js';
import { buildSegment, type RouteSegment } from './route.js';
import type { OsrmRoute } from './osrm.js';
import type { TraceSighting } from './trace.js';

const POLICY = loadAnomalyPolicy();
const CONFUSIONS = loadConfusions();

/* ── fixtures ─────────────────────────────────────────────────────────────────────────────────── */

const CAMERAS: Record<string, { id: string; name: string; lon: number; lat: number }> = {
  A: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Paldi Circle',
    lon: 72.5714,
    lat: 23.0225,
  },
  B: { id: '22222222-2222-4222-8222-222222222222', name: 'Janpath', lon: 72.5871, lat: 23.0311 },
  D: {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Visat Teen Rasta',
    lon: 72.6218,
    lat: 23.0611,
  },
};

let counter = 0;

interface SightingOptions {
  camera: keyof typeof CAMERAS;
  atSeconds: number;
  plate?: string;
  ocrConfidence?: number;
  linkConfidence?: number;
  crop?: string | null;
  trackId?: number;
}

function sighting(options: SightingOptions): TraceSighting {
  const place = CAMERAS[options.camera] ?? CAMERAS['A'];
  const plate = options.plate ?? 'GJ01AB1234';
  const crop = options.crop === undefined ? `s3://evidence/${plate}-${counter}.jpg` : options.crop;
  counter += 1;
  const at = Date.UTC(2026, 8, 5, 9, 0, 0) + options.atSeconds * 1000;
  return {
    seq: counter,
    sightingId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    ts: new Date(at).toISOString(),
    framePtsMs: options.atSeconds * 1000,
    cameraId: place?.id ?? '',
    cameraExternalId: `ANOMFIX-${options.camera}`,
    cameraName: place?.name ?? '',
    district: 'Ahmedabad',
    lat: place?.lat ?? null,
    lon: place?.lon ?? null,
    located: true,
    trackId: options.trackId ?? 300_000 + counter,
    trackingSession: Math.trunc((options.trackId ?? 300_000 + counter) / 100_000),
    rawTrackerId: (options.trackId ?? 300_000 + counter) % 100_000,
    class: 'car',
    detConfidence: 0.91,
    vehicleColor: 'white',
    vehicleColorConfidence: 0.7,
    attributesLowConfidence: false,
    isBestShot: true,
    cropUri: crop,
    cropUrl: crop === null ? null : `https://minio.example/${plate}-${counter}?X-Amz-Signature=x`,
    plateNormalized: plate,
    plateRawText: plate,
    ocrConfidence: options.ocrConfidence ?? 0.88,
    voteCount: 3,
    linkMethod: 'plate_exact',
    linkConfidence: options.linkConfidence ?? 0.8,
    matchDistance: 0,
    matchStrength: 1,
    explanation: 'exact match',
    basis: 'observed',
    retention: describeRetention({ footageAt: new Date(at), retentionDays: null }),
  };
}

/** A stub road graph reading. `buildSegment` is D3-01's, unchanged — the physics is imported. */
function osrm(distanceKm: number, durationS: number): OsrmRoute {
  return {
    distanceM: distanceKm * 1000,
    durationS,
    geometry: {
      type: 'LineString',
      coordinates: [
        [72.5714, 23.0225],
        [72.6218, 23.0611],
      ],
    },
    options: 1,
    alternativeSpread: null,
  };
}

/** One `inferred_path` segment built by D3-01's own builder, so nothing here restates the model. */
function segmentOf(from: TraceSighting, to: TraceSighting, route: OsrmRoute | null): RouteSegment {
  return buildSegment(1, from, to, route);
}

function withPolicy(over: {
  maxPlausibleKmh?: number;
  graphSpeedTolerance?: number;
  highOcrConfidence?: number;
  repeatPairsForClone?: number;
  minLinkConfidence?: number;
}): AnomalyPolicy {
  return {
    ...POLICY,
    speed: {
      ...POLICY.speed,
      maxPlausibleKmh: over.maxPlausibleKmh ?? POLICY.speed.maxPlausibleKmh,
      graphSpeedTolerance: over.graphSpeedTolerance ?? POLICY.speed.graphSpeedTolerance,
    },
    disambiguation: {
      ...POLICY.disambiguation,
      highOcrConfidence: over.highOcrConfidence ?? POLICY.disambiguation.highOcrConfidence,
      repeatPairsForClone: over.repeatPairsForClone ?? POLICY.disambiguation.repeatPairsForClone,
    },
    alert: {
      ...POLICY.alert,
      minLinkConfidence: over.minLinkConfidence ?? POLICY.alert.minLinkConfidence,
    },
  };
}

/* ── AC 1 and AC 2 — the two synthetic transitions ────────────────────────────────────────────── */

describe('feasibility (AC 1, AC 2)', () => {
  it('AC 1 — 200 km apart, 60 seconds apart, is flagged impossible', () => {
    // OSRM's fastest path for 200 km of Gujarat highway: 2 hours. The vehicle claims one minute.
    const segment = segmentOf(
      sighting({ camera: 'A', atSeconds: 0 }),
      sighting({ camera: 'D', atSeconds: 60 }),
      osrm(200, 7200),
    );
    expect(segment.kind).toBe('inferred_path');
    // The lower bound on average speed, which is the quantity the test is allowed to use.
    expect(segment.minimumAverageSpeedKmh).toBe(12_000);

    const verdict = assessFeasibility(segment, POLICY);
    expect(verdict.feasibility).toBe('impossible');
    // Both tests fire, and they are independent: one divides by elapsed, the other does not.
    expect(verdict.failedTests).toEqual(['minimum_average_speed', 'faster_than_free_flow']);
  });

  it('AC 2 — 5 km apart, 15 minutes apart, is NOT flagged', () => {
    const segment = segmentOf(
      sighting({ camera: 'A', atSeconds: 0 }),
      sighting({ camera: 'B', atSeconds: 900 }),
      osrm(5, 400),
    );
    expect(segment.minimumAverageSpeedKmh).toBe(20);

    const verdict = assessFeasibility(segment, POLICY);
    expect(verdict.feasibility).toBe('feasible');
    expect(verdict.failedTests).toEqual([]);
  });

  it('“feasible” is stated as “not shown to be impossible”, never as a clean bill of health', () => {
    const report = analyseRoute(
      [
        segmentOf(
          sighting({ camera: 'A', atSeconds: 0 }),
          sighting({ camera: 'B', atSeconds: 900 }),
          osrm(5, 400),
        ),
      ],
      [],
      'GJ01AB1234',
      POLICY,
      CONFUSIONS,
    );
    // No sightings supplied, so nothing is emitted — the finding needs both endpoints.
    expect(report.findings).toHaveLength(0);
    expect(ANOMALY_COPY.feasible).toContain('Not shown to be impossible');
    expect(ANOMALY_COPY.feasible).toContain('not a clean bill of health');
  });
});

/* ── the null discipline D3-01 warned about ───────────────────────────────────────────────────── */

describe('only a routed transition is eligible; null is never treated as zero', () => {
  it('an unroutable hop is indeterminate, not impossible — the normal case on the real estate', () => {
    const from = sighting({ camera: 'A', atSeconds: 0 });
    const to = { ...sighting({ camera: 'D', atSeconds: 2 }), located: false, lat: null, lon: null };
    const segment = segmentOf(from, to, null);
    expect(segment.kind).toBe('inferred_unroutable');
    expect(segment.expectedTravelTimeS).toBeNull();
    expect(assessFeasibility(segment, POLICY).feasibility).toBe('indeterminate');
  });

  it('a same-camera revisit is indeterminate — where it went is unbounded, so no speed exists', () => {
    const segment = segmentOf(
      sighting({ camera: 'A', atSeconds: 0, trackId: 300_001 }),
      sighting({ camera: 'A', atSeconds: 5, trackId: 900_001 }),
      null,
    );
    expect(segment.kind).toBe('inferred_revisit');
    expect(assessFeasibility(segment, POLICY).feasibility).toBe('indeterminate');
  });

  it('an observed dwell is never flagged — the movement was on video', () => {
    const segment = segmentOf(
      sighting({ camera: 'A', atSeconds: 0, trackId: 300_001 }),
      sighting({ camera: 'A', atSeconds: 45, trackId: 300_001 }),
      null,
    );
    expect(segment.kind).toBe('observed_dwell');
    expect(assessFeasibility(segment, POLICY).feasibility).toBe('indeterminate');
  });

  it('a two-second hop below the quantisation guard is still impossible on the free-flow test', () => {
    // The guard protects the test that DIVIDES by elapsed. The other one does not divide, and two
    // seconds against a 420-second free-flow expectation is impossible however coarse the clock is.
    const segment = segmentOf(
      sighting({ camera: 'A', atSeconds: 0 }),
      sighting({ camera: 'D', atSeconds: 2 }),
      osrm(6, 420),
    );
    const verdict = assessFeasibility(segment, POLICY);
    expect(verdict.feasibility).toBe('impossible');
    expect(verdict.failedTests).toEqual(['faster_than_free_flow']);
  });
});

/* ── AC 3 — the speed tolerance is config ─────────────────────────────────────────────────────── */

describe('AC 3 — speed tolerance is config; changing it moves the boundary with no code change', () => {
  // 50 km covered in 20 minutes: a minimum average of 150 km/h, against a free-flow estimate of
  // 25 minutes. Only the speed test can decide this one, so the boundary is visible in isolation.
  const segment = (): RouteSegment =>
    segmentOf(
      sighting({ camera: 'A', atSeconds: 0 }),
      sighting({ camera: 'D', atSeconds: 1200 }),
      osrm(50, 1500),
    );

  it('is impossible at the shipped ceiling of 140 km/h', () => {
    const s = segment();
    expect(s.minimumAverageSpeedKmh).toBe(150);
    expect(POLICY.speed.maxPlausibleKmh).toBe(140);
    const verdict = assessFeasibility(s, POLICY);
    expect(verdict.feasibility).toBe('impossible');
    expect(verdict.failedTests).toEqual(['minimum_average_speed']);
  });

  it('is feasible at a ceiling of 160 km/h — same segment, same code, different policy', () => {
    const verdict = assessFeasibility(segment(), withPolicy({ maxPlausibleKmh: 160 }));
    expect(verdict.feasibility).toBe('feasible');
    expect(verdict.failedTests).toEqual([]);
  });

  it('the free-flow tolerance is config in the same way', () => {
    // 12 km in 400 s: 108 km/h, under every ceiling. The graph prices the fastest path at 520 s.
    const s = segmentOf(
      sighting({ camera: 'A', atSeconds: 0 }),
      sighting({ camera: 'D', atSeconds: 400 }),
      osrm(12, 520),
    );
    expect(assessFeasibility(s, withPolicy({ graphSpeedTolerance: 1.0 })).failedTests).toEqual([
      'faster_than_free_flow',
    ]);
    expect(assessFeasibility(s, withPolicy({ graphSpeedTolerance: 1.5 })).feasibility).toBe(
      'feasible',
    );
  });

  it('the policy really is read from disk, so a file on disk changes the boundary', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'anomaly-policy-'));
    const file = path.join(dir, 'anomaly-policy.json');
    writeFileSync(
      file,
      JSON.stringify({ ...POLICY, speed: { ...POLICY.speed, maxPlausibleKmh: 500 } }),
    );
    const loaded = loadAnomalyPolicy(file);
    expect(loaded.speed.maxPlausibleKmh).toBe(500);
    expect(assessFeasibility(segment(), loaded).feasibility).toBe('feasible');
  });
});

/* ── AC 4 and AC 5 — misread or clone ─────────────────────────────────────────────────────────── */

describe('AC 4, AC 5 — the misread branch, on real low-confidence reads', () => {
  it('a truncated read at 0.503 against a full read at 0.732 is a misread, and names the alternative', () => {
    // GJ35U0779 -> GJ35U07 is D2-04's measured truncation case: a clean prefix, priced at 0.35 per
    // character, and this estate's dominant OCR failure. It is one vehicle read badly.
    const from = sighting({ camera: 'A', atSeconds: 0, plate: 'GJ35U0779', ocrConfidence: 0.732 });
    const to = sighting({ camera: 'D', atSeconds: 60, plate: 'GJ35U07', ocrConfidence: 0.503 });

    const result = disambiguate(from, to, POLICY, 1, CONFUSIONS);
    expect(result.explanation).toBe('likely_misread');

    const candidate = result.candidateAlternative;
    expect(candidate).not.toBeNull();
    // AC 5: the alternative surfaced is the *other* read — what the weaker end may have been.
    expect(candidate?.plate).toBe('GJ35U0779');
    expect(candidate?.weakerEndpoint).toBe('to');
    expect(candidate?.truncation).toBe(true);
    expect(candidate?.tailChars).toBeGreaterThan(0);
    // Fractional and weighted, never an integer edit distance, and never above D2-04's ceiling.
    expect(candidate?.distance).toBeGreaterThan(0);
    expect(candidate?.distance).toBeLessThanOrEqual(POLICY.disambiguation.maxNeighbourDistance);
    expect(Number.isInteger(candidate?.distance)).toBe(false);
  });

  it('a confusable substitution within the budget is a misread and surfaces the neighbour', () => {
    // GJ01A81234 vs GJ01AB1234 — the B/8 confusion, the fixture itinerary's own CAM-D read.
    const from = sighting({ camera: 'A', atSeconds: 0, plate: 'GJ01AB1234', ocrConfidence: 0.79 });
    const to = sighting({ camera: 'D', atSeconds: 60, plate: 'GJ01A81234', ocrConfidence: 0.55 });
    const result = disambiguate(from, to, POLICY, 1, CONFUSIONS);
    expect(result.explanation).toBe('likely_misread');
    expect(result.candidateAlternative?.plate).toBe('GJ01AB1234');
    expect(result.candidateAlternative?.truncation).toBe(false);
  });

  it('an identical pair with one low-confidence read is a misread, with no alternative invented', () => {
    // 0.449 is the weakest of the five legible reads the live estate produced. Two identical
    // strings leave nothing for OCR to have got wrong *between* them, so no alternative exists and
    // none is manufactured.
    const from = sighting({ camera: 'A', atSeconds: 0, ocrConfidence: 0.449 });
    const to = sighting({ camera: 'D', atSeconds: 60, ocrConfidence: 0.88 });
    const result = disambiguate(from, to, POLICY, 3, CONFUSIONS);
    expect(result.explanation).toBe('likely_misread');
    expect(result.candidateAlternative).toBeNull();
  });

  it('two unrelated plates are not offered as neighbours of each other', () => {
    const from = sighting({ camera: 'A', atSeconds: 0, plate: 'GJ01AB1234' });
    const to = sighting({ camera: 'D', atSeconds: 60, plate: 'MH12XY9876' });
    expect(candidateFor(from, to, POLICY, CONFUSIONS)).toBeNull();
  });
});

describe('AC 4 — the clone branch, on real high-confidence reads', () => {
  it('identical, confident, grammar-valid reads that repeat are called likely_cloned', () => {
    const from = sighting({ camera: 'A', atSeconds: 0, ocrConfidence: 0.88 });
    const to = sighting({ camera: 'D', atSeconds: 60, ocrConfidence: 0.83 });
    const result = disambiguate(from, to, POLICY, 2, CONFUSIONS);
    expect(result.explanation).toBe('likely_cloned');
    expect(result.candidateAlternative).toBeNull();
  });

  it('the same pair seen once is undetermined — one anomaly is not a pattern', () => {
    const from = sighting({ camera: 'A', atSeconds: 0, ocrConfidence: 0.88 });
    const to = sighting({ camera: 'D', atSeconds: 60, ocrConfidence: 0.83 });
    expect(disambiguate(from, to, POLICY, 1, CONFUSIONS).explanation).toBe('undetermined');
  });

  it('a read the plate grammar refuses can never support a clone verdict', () => {
    // 757508300 is a hoarding's phone number and was the highest-confidence read of the whole live
    // run. It identifies nothing, so it cannot be evidence that a registration is duplicated.
    const from = sighting({ camera: 'A', atSeconds: 0, plate: '757508300', ocrConfidence: 0.95 });
    const to = sighting({ camera: 'D', atSeconds: 60, plate: '757508300', ocrConfidence: 0.95 });
    expect(disambiguate(from, to, POLICY, 5, CONFUSIONS).explanation).toBe('undetermined');
  });
});

/* ── AC 6 — the alert, with side-by-side crops ────────────────────────────────────────────────── */

describe('AC 6 — cloning suspicion raises its own alert, carrying both crops', () => {
  /** Camera A to camera D twice, an hour apart. Two impossible transitions on the same pair. */
  function clonedRoute(over: Partial<SightingOptions> = {}): {
    segments: RouteSegment[];
    sightings: TraceSighting[];
  } {
    const s = [
      sighting({ camera: 'A', atSeconds: 0, ocrConfidence: 0.88, ...over }),
      sighting({ camera: 'D', atSeconds: 60, ocrConfidence: 0.83, ...over }),
      sighting({ camera: 'A', atSeconds: 3600, ocrConfidence: 0.88, ...over }),
      sighting({ camera: 'D', atSeconds: 3660, ocrConfidence: 0.83, ...over }),
    ];
    const route = osrm(24, 1800);
    const segments = [
      buildSegment(1, s[0] as TraceSighting, s[1] as TraceSighting, route),
      buildSegment(2, s[1] as TraceSighting, s[2] as TraceSighting, osrm(24, 1800)),
      buildSegment(3, s[2] as TraceSighting, s[3] as TraceSighting, route),
    ];
    return { segments, sightings: s };
  }

  it('raises one alert per cloned pair, with the two crops side by side', () => {
    const { segments, sightings } = clonedRoute();
    const report = analyseRoute(segments, sightings, 'GJ01AB1234', POLICY, CONFUSIONS);

    expect(report.impossible).toBe(2);
    expect(report.likelyCloned).toBe(2);
    expect(report.alerts).toBe(2);

    const finding = report.findings.find((f) => f.alert !== null);
    const alert = finding?.alert;
    expect(alert?.kind).toBe('cloned_plate_suspected');
    // Severity comes from config, not from the model's opinion.
    expect(alert?.severity).toBe(POLICY.alert.severity);
    // Side by side: two named sides, each with its own crop and its own reading.
    expect(alert?.evidence.left.cropUri).not.toBeNull();
    expect(alert?.evidence.right.cropUri).not.toBeNull();
    expect(alert?.evidence.left.cropUrl).not.toBeNull();
    expect(alert?.evidence.right.cropUrl).not.toBeNull();
    expect(alert?.evidence.left.cameraName).not.toBe(alert?.evidence.right.cameraName);
    expect(alert?.cropsIncomplete).toBe(false);
    expect(finding?.repeatedPairs).toBe(2);
    expect(finding?.anomaly).toBe('impossible_transition');
  });

  it('says so when a crop is missing rather than rendering an empty frame', () => {
    const { segments, sightings } = clonedRoute({ crop: null });
    const report = analyseRoute(segments, sightings, 'GJ01AB1234', POLICY, CONFUSIONS);
    const alert = report.findings.find((f) => f.alert !== null)?.alert;
    expect(alert?.cropsIncomplete).toBe(true);
    expect(ANOMALY_COPY.cropsIncomplete).toContain('cannot be compared');
  });

  it('a weakly linked pair is reported but not escalated', () => {
    // D2-08 measured mean link confidence for recoverable reads at 0.34-0.59. A finding built on
    // two links at 0.34 is two possibilities, not two identifications.
    const { segments, sightings } = clonedRoute({ linkConfidence: 0.34 });
    const report = analyseRoute(segments, sightings, 'GJ01AB1234', POLICY, CONFUSIONS);
    expect(report.likelyCloned).toBe(2);
    expect(report.alerts).toBe(0);
    expect(report.findings[0]?.linkConfidence).toBeLessThan(POLICY.alert.minLinkConfidence);
  });

  it('the alert severity is config — the same route escalates differently under another policy', () => {
    const { segments, sightings } = clonedRoute();
    const policy: AnomalyPolicy = { ...POLICY, alert: { ...POLICY.alert, severity: 'high' } };
    const report = analyseRoute(segments, sightings, 'GJ01AB1234', policy, CONFUSIONS);
    expect(report.findings.find((f) => f.alert !== null)?.alert?.severity).toBe('high');
  });

  it('a legitimate route raises nothing at all', () => {
    const s = [
      sighting({ camera: 'A', atSeconds: 0 }),
      sighting({ camera: 'B', atSeconds: 900 }),
      sighting({ camera: 'D', atSeconds: 2400 }),
    ];
    const segments = [
      buildSegment(1, s[0] as TraceSighting, s[1] as TraceSighting, osrm(5, 400)),
      buildSegment(2, s[1] as TraceSighting, s[2] as TraceSighting, osrm(12, 900)),
    ];
    const report = analyseRoute(segments, s, 'GJ01AB1234', POLICY, CONFUSIONS);
    expect(report.segmentsExamined).toBe(2);
    expect(report.segmentsEvaluable).toBe(2);
    expect(report.impossible).toBe(0);
    expect(report.alerts).toBe(0);
  });
});

/* ── AC 7 — the copy test ─────────────────────────────────────────────────────────────────────── */

describe('AC 7 — the output never claims certainty', () => {
  /**
   * Words that would turn a physical inconsistency into an accusation. A system with no VAHAN or
   * SARTHI link cannot confirm that a registration exists or who holds it, so none of these can
   * ever be honest here.
   */
  const FORBIDDEN = [
    'confirmed',
    'confirms',
    'proves',
    'proven',
    'definitely',
    'certainly',
    'without doubt',
    'beyond doubt',
    'guilty',
    'criminal',
    'offender',
    'is cloned',
    'is a clone',
    'has been cloned',
    'stolen',
    'fraud',
  ];

  /** Every string this module can put in front of a human, gathered from a real analysis. */
  function everyRenderedString(): string[] {
    const out: string[] = Object.values(ANOMALY_COPY);
    const s = [
      sighting({ camera: 'A', atSeconds: 0, ocrConfidence: 0.88 }),
      sighting({ camera: 'D', atSeconds: 60, ocrConfidence: 0.83 }),
      sighting({ camera: 'A', atSeconds: 3600, ocrConfidence: 0.88 }),
      sighting({ camera: 'D', atSeconds: 3660, ocrConfidence: 0.83 }),
      sighting({ camera: 'A', atSeconds: 7200, plate: 'GJ35U0779', ocrConfidence: 0.732 }),
      sighting({ camera: 'D', atSeconds: 7260, plate: 'GJ35U07', ocrConfidence: 0.503 }),
      sighting({ camera: 'B', atSeconds: 9000 }),
    ];
    const segments = s
      .slice(1)
      .map((to, i) => buildSegment(i + 1, s[i] as TraceSighting, to, osrm(24, 1800)));
    const report = analyseRoute(segments, s, 'GJ01AB1234', POLICY, CONFUSIONS);
    out.push(report.disclaimer);
    for (const f of report.findings) {
      out.push(f.headline, f.why, f.alternativeExplanation, f.limitations);
      if (f.candidateAlternative !== null) out.push(f.candidateAlternative.note);
      if (f.alert !== null) {
        out.push(
          f.alert.headline,
          f.alert.why,
          f.alert.alternativeExplanation,
          f.alert.limitations,
        );
      }
    }
    return out;
  }

  it('renders at least one string from every branch, so the scan is not scanning nothing', () => {
    const strings = everyRenderedString();
    expect(strings.length).toBeGreaterThan(30);
    expect(strings.some((t) => t.includes('Most likely cause'))).toBe(true);
  });

  it('no rendered string asserts cloning, criminality or certainty', () => {
    for (const text of everyRenderedString()) {
      const lower = text.toLowerCase();
      for (const word of FORBIDDEN) {
        expect(lower.includes(word), `"${word}" appears in: ${text}`).toBe(false);
      }
    }
  });

  it('the clone verdict hedges in its own words, and names the innocent explanation', () => {
    expect(ANOMALY_COPY.clonedHeadline).toContain('Most likely cause');
    expect(ANOMALY_COPY.clonedHeadline).toContain('appears to be');
    expect(ANOMALY_COPY.clonedAlternative.toLowerCase()).toContain('would look identical');
    expect(ANOMALY_COPY.limitations).toContain('not the road taken');
  });

  it('the disclaimer states the absence of a registry link rather than implying one', () => {
    expect(ANOMALY_COPY.disclaimer).toContain('no link to VAHAN or SARTHI');
    expect(ANOMALY_COPY.disclaimer).toContain('not an accusation');
  });

  it('every impossible finding carries an alternative explanation, never a bare verdict', () => {
    const s = [
      sighting({ camera: 'A', atSeconds: 0, ocrConfidence: 0.88 }),
      sighting({ camera: 'D', atSeconds: 60, ocrConfidence: 0.83 }),
    ];
    const report = analyseRoute(
      [buildSegment(1, s[0] as TraceSighting, s[1] as TraceSighting, osrm(24, 1800))],
      s,
      'GJ01AB1234',
      POLICY,
      CONFUSIONS,
    );
    for (const f of report.findings.filter((x) => x.feasibility === 'impossible')) {
      expect(f.alternativeExplanation.length).toBeGreaterThan(40);
      expect(f.limitations.length).toBeGreaterThan(40);
    }
  });
});
