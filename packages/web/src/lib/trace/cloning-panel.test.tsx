// @vitest-environment jsdom

/**
 * D3-02 — the investigation view, driven rather than read.
 *
 * Two acceptance criteria land here and neither is assertable from the API alone:
 *
 *  - **AC 6**, *"cloning suspicion raises an alert with side-by-side crop evidence"* — a payload
 *    carrying two crop URLs proves the data exists; only rendering the component proves an officer
 *    can see them next to each other.
 *  - **AC 7**, *"output language never claims certainty — asserted by a copy test on the rendered
 *    strings"*. `anomaly.test.ts` scans the strings the API produces; this scans what actually
 *    reaches the DOM, including the labels the component adds on its own. A component that
 *    relabelled a hedged verdict as "Cloned" would pass the API copy test and fail here.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CloningPanel } from '@/app/(shell)/trace/cloning-panel';
import type { TracePayload } from '@/app/(shell)/trace/types';

afterEach(cleanup);

type AnomalyReport = NonNullable<TracePayload['route']>['anomalies'];
type Finding = AnomalyReport['findings'][number];
type EvidenceSide = NonNullable<Finding['alert']>['evidence']['left'];

const DISCLAIMER =
  'A finding here is not an accusation. It says two sightings are inconsistent with a single ' +
  'vehicle, and no more than that. This system has no link to VAHAN or SARTHI, so it cannot ' +
  'confirm that a registration exists, that it was validly issued, or who holds it.';

function side(over: Partial<EvidenceSide> = {}): EvidenceSide {
  return {
    sightingId: '00000000-0000-4000-8000-000000000001',
    ts: '2026-09-05T10:00:00.000Z',
    cameraId: '11111111-1111-4111-8111-111111111111',
    cameraName: 'Paldi Circle (fixture)',
    plateNormalized: 'GJ01AB1234',
    plateRawText: 'GJ 01 AB 1234',
    ocrConfidence: 0.86,
    linkMethod: 'plate_exact',
    linkConfidence: 0.86,
    grammarValid: true,
    cropUri: 's3://evidence/left.jpg',
    cropUrl: 'https://minio.example/left.jpg?X-Amz-Signature=x',
    ...over,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    seq: 1,
    fromSightingId: '00000000-0000-4000-8000-000000000001',
    toSightingId: '00000000-0000-4000-8000-000000000002',
    fromCameraName: 'Visat Teen Rasta (fixture)',
    toCameraName: 'Paldi Circle (fixture)',
    feasibility: 'impossible',
    anomaly: 'impossible_transition',
    failedTests: ['minimum_average_speed', 'faster_than_free_flow'],
    elapsedSeconds: 30,
    roadDistanceKm: 9.244,
    expectedTravelTimeS: 669.1,
    minimumAverageSpeedKmh: 1109.3,
    elapsedVsExpected: 0.045,
    explanation: 'likely_cloned',
    candidateAlternative: null,
    repeatedPairs: 2,
    linkConfidence: 0.85,
    headline:
      'Physically impossible transition — the fastest road between these two cameras cannot be ' +
      'driven in the time between the two reads. Most likely cause: the same registration appears ' +
      'to be in use on more than one vehicle.',
    why: 'Both reads are the same string, both carry OCR confidence in the upper part of this estate’s measured range.',
    alternativeExplanation:
      'A repeated OCR failure that lands on the same wrong string at both cameras would look identical to this.',
    limitations:
      'Limits of this finding: the road distance is the fastest path the graph knows, not the road taken.',
    alert: {
      kind: 'cloned_plate_suspected',
      severity: 'medium',
      plate: 'GJ01AB1234',
      evidence: {
        left: side({ cameraName: 'Visat Teen Rasta (fixture)' }),
        right: side({
          cameraName: 'Paldi Circle (fixture)',
          cropUri: 's3://evidence/right.jpg',
          cropUrl: 'https://minio.example/right.jpg?X-Amz-Signature=y',
        }),
      },
      cropsIncomplete: false,
      headline: 'Physically impossible transition — most likely cause: a duplicated registration.',
      why: 'Both reads are the same string and both are confident.',
      alternativeExplanation: 'A repeated OCR failure would look identical to this.',
      limitations: 'The road distance is the fastest path the graph knows, not the road taken.',
    },
    ...over,
  };
}

function report(over: Partial<AnomalyReport> = {}): AnomalyReport {
  return {
    plate: 'GJ01AB1234',
    segmentsExamined: 10,
    segmentsEvaluable: 7,
    impossible: 1,
    likelyMisread: 0,
    likelyCloned: 1,
    undetermined: 0,
    alerts: 1,
    findings: [finding()],
    policy: { maxPlausibleKmh: 140, graphSpeedTolerance: 1.35, version: 1 },
    disclaimer: DISCLAIMER,
    ...over,
  };
}

describe('AC 6 — the two conflicting reads are rendered side by side', () => {
  it('renders both crops, each captioned with its own camera, read and confidences', () => {
    render(<CloningPanel anomalies={report()} />);

    const crops = screen.getByTestId('cloning-crops');
    const images = within(crops).getAllByRole('img');
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveProperty('src', 'https://minio.example/left.jpg?X-Amz-Signature=x');
    expect(images[1]).toHaveProperty('src', 'https://minio.example/right.jpg?X-Amz-Signature=y');

    // Each side carries its own reading, so a reader can tell which crop is which.
    const left = screen.getByTestId('cloning-crop-left');
    const right = screen.getByTestId('cloning-crop-right');
    expect(left.textContent).toContain('Visat Teen Rasta');
    expect(right.textContent).toContain('Paldi Circle');
    expect(left.textContent).toContain('0.86');
    expect(screen.getByTestId('cloning-alert').dataset['severity']).toBe('medium');
  });

  it('says a crop is missing rather than rendering an empty frame', () => {
    const f = finding();
    const alert = f.alert;
    if (alert === null) throw new Error('fixture must carry an alert');
    render(
      <CloningPanel
        anomalies={report({
          findings: [
            {
              ...f,
              alert: {
                ...alert,
                cropsIncomplete: true,
                evidence: {
                  left: side({ cropUri: null, cropUrl: null }),
                  right: alert.evidence.right,
                },
              },
            },
          ],
        })}
      />,
    );
    expect(within(screen.getByTestId('cloning-crops')).getAllByRole('img')).toHaveLength(1);
    expect(screen.getByTestId('cloning-crop-left').textContent).toContain('No crop kept');
    expect(screen.getByTestId('cloning-crops-incomplete').textContent).toContain(
      'cannot be compared here',
    );
  });

  it('shows the arithmetic, and calls the speed a minimum', () => {
    render(<CloningPanel anomalies={report()} />);
    const figures = screen.getByTestId('cloning-arithmetic');
    expect(figures.textContent).toContain('Minimum average');
    expect(figures.textContent).toContain('1109 km/h');
    expect(figures.textContent).toContain('9.24 km');
    expect(figures.textContent).toContain('30 s');
  });
});

describe('AC 5 — the candidate alternative plate is surfaced, never a bare distance', () => {
  it('renders the alternative plate with its weighted distance and its note', () => {
    render(
      <CloningPanel
        anomalies={report({
          findings: [
            finding({
              explanation: 'likely_misread',
              alert: null,
              candidateAlternative: {
                plate: 'GJ35U0779',
                distance: 0.7,
                tailChars: 2,
                truncation: true,
                weakerEndpoint: 'to',
                note: 'One read is a clean prefix of the other, which is this estate’s most common failure.',
              },
            }),
          ],
        })}
      />,
    );
    const candidate = screen.getByTestId('cloning-candidate');
    expect(candidate.textContent).toContain('GJ35U0779');
    // Fractional, three decimals, and never standing on its own without the plate beside it.
    expect(candidate.textContent).toContain('0.700');
    expect(candidate.textContent).toContain('clean prefix');
  });
});

describe('AC 7 — the rendered DOM never claims certainty', () => {
  const FORBIDDEN = [
    'confirmed',
    'proves',
    'definitely',
    'certainly',
    'guilty',
    'criminal',
    'is cloned',
    'is a clone',
    'stolen',
    'fraud',
  ];

  it('no visible text asserts cloning or criminality', () => {
    render(<CloningPanel anomalies={report()} />);
    const text = (screen.getByTestId('cloning-panel').textContent ?? '').toLowerCase();
    expect(text.length).toBeGreaterThan(200);
    for (const word of FORBIDDEN) {
      expect(text.includes(word), `"${word}" is rendered`).toBe(false);
    }
  });

  it('the verdict badge hedges, and the alternative explanation is rendered with it', () => {
    render(<CloningPanel anomalies={report()} />);
    expect(screen.getByTestId('cloning-verdict').textContent).toBe(
      'Most likely a duplicated registration',
    );
    expect(screen.getByTestId('cloning-alternative').textContent).toContain('would look identical');
    expect(screen.getByTestId('cloning-panel').textContent).toContain('no link to VAHAN or SARTHI');
  });

  it('an empty result says which kind of empty it is', () => {
    render(
      <CloningPanel
        anomalies={report({
          findings: [],
          impossible: 0,
          likelyCloned: 0,
          alerts: 0,
          segmentsEvaluable: 0,
        })}
      />,
    );
    // Nothing assessable is NOT the same claim as nothing wrong, and the copy says so.
    expect(screen.getByTestId('cloning-empty').textContent).toContain('could be assessed');
    expect(screen.getByTestId('cloning-empty').textContent).toContain(
      'not a finding that the route is consistent',
    );
  });

  it('an assessed-but-clean result is stated as “not shown to be impossible”', () => {
    render(
      <CloningPanel
        anomalies={report({ findings: [], impossible: 0, likelyCloned: 0, alerts: 0 })}
      />,
    );
    expect(screen.getByTestId('cloning-empty').textContent).toContain('lower bound');
    expect(screen.getByTestId('cloning-empty').textContent).toContain('not a verification');
  });
});
