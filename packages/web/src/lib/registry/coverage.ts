/**
 * Coverage overlay — the single source of what the three states look like and what they mean.
 *
 * Shaped after `trust.ts` on purpose. That module exists because a colour derived in three places
 * drifts in three places, and its test asserts that no numeric threshold ever leaks into the paint
 * expression. The same rule applies here for the same reason, plus one specific to this overlay:
 *
 * **`covered (untrusted)` must never be allowed to read as "a bit worse than trusted".** It is the
 * state the entire gap analysis is about — road that a conventional coverage map would paint green
 * because a camera points at it, while nobody has established that the camera can see. On the
 * estate D3-06 measured, *every* covered metre is in this state.
 *
 * ## Why there are three states and only two sources of geometry
 *
 * `trusted` and `untrusted` are polygons from `GET /api/v1/coverage/overlay`. `uncovered` has no
 * geometry at all: it is the absence of a cell over the basemap's own road layers. Shipping 540,584
 * uncovered ways to a browser to colour them grey would cost tens of megabytes to render a
 * negative. The legend therefore says what the *absence* means, which is the part a reader cannot
 * infer from the picture.
 */

export const COVERAGE_STATES = ['trusted', 'untrusted', 'uncovered'] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

export interface CoverageStyle {
  /** Polygon fill, or `null` for the state that has no geometry. */
  readonly fill: string | null;
  readonly outline: string;
  readonly opacity: number;
  readonly label: string;
  /** What the colour actually asserts. In the legend, because a colour alone lies. */
  readonly meaning: string;
  readonly chip: string;
}

export const COVERAGE_STYLE: Record<CoverageState, CoverageStyle> = {
  trusted: {
    fill: '#10b981',
    outline: '#065f46',
    opacity: 0.28,
    label: 'Covered (trusted)',
    meaning:
      'A camera reaches this road and its measured signals are within tolerance. This is the only state that counts towards the trusted-coverage figure.',
    chip: 'border-emerald-800 bg-emerald-950/60 text-emerald-300',
  },
  untrusted: {
    fill: '#f59e0b',
    outline: '#78350f',
    opacity: 0.22,
    label: 'Covered (untrusted or never probed)',
    meaning:
      'A camera reaches this road, but it is dead, degraded, blind, or has never been probed at all. A conventional coverage map draws this the same colour as trusted coverage. That is the false assurance this overlay exists to break.',
    chip: 'border-amber-800 bg-amber-950/60 text-amber-300',
  },
  uncovered: {
    fill: null,
    outline: '#475569',
    opacity: 0,
    label: 'Uncovered',
    meaning:
      'No camera reaches this road. Drawn as the absence of a cell over the basemap rather than as 540,584 grey lines — so bare road is uncovered road.',
    chip: 'border-slate-700 bg-slate-800/60 text-slate-400',
  },
};

/** MapLibre `fill-color` for the cell layer, keyed on the feature's `state`. */
export function coverageFillExpression(): unknown[] {
  return [
    'match',
    ['get', 'state'],
    ...COVERAGE_STATES.flatMap((s) => [s, COVERAGE_STYLE[s].fill ?? 'rgba(0,0,0,0)']),
    'rgba(0,0,0,0)',
  ];
}

export function coverageOpacityExpression(): unknown[] {
  return [
    'match',
    ['get', 'state'],
    ...COVERAGE_STATES.flatMap((s) => [s, COVERAGE_STYLE[s].opacity]),
    0,
  ];
}

export function coverageOutlineExpression(): unknown[] {
  return [
    'match',
    ['get', 'state'],
    ...COVERAGE_STATES.flatMap((s) => [s, COVERAGE_STYLE[s].outline]),
    '#475569',
  ];
}

export interface CoverageFeature {
  type: 'Feature';
  id: string;
  geometry: unknown;
  properties: { id: string; externalId: string; state: string; band: string; rangeM: number };
}

export interface CoverageFeatureCollection {
  type: 'FeatureCollection';
  features: CoverageFeature[];
}

export const EMPTY_COVERAGE: CoverageFeatureCollection = { type: 'FeatureCollection', features: [] };

/** Cell counts per state — the legend's numbers. */
export function countByState(data: CoverageFeatureCollection): Record<CoverageState, number> {
  const counts: Record<CoverageState, number> = { trusted: 0, untrusted: 0, uncovered: 0 };
  for (const feature of data.features) {
    const state = feature.properties.state;
    if (isCoverageState(state)) counts[state] += 1;
  }
  return counts;
}

export function isCoverageState(value: string): value is CoverageState {
  return (COVERAGE_STATES as readonly string[]).includes(value);
}

/**
 * The sentence under the legend. It changes with the data because the degenerate case — every cell
 * untrusted — is the finding, not a rendering glitch, and a static caption would let a reader
 * assume the overlay was broken.
 */
export function coverageCaption(data: CoverageFeatureCollection): string {
  const counts = countByState(data);
  const drawn = counts.trusted + counts.untrusted;
  if (drawn === 0) {
    return 'No coverage cells. Run `npm run report:gap-analysis` to populate `camera_coverage`, or check that any camera carries coordinates.';
  }
  if (counts.trusted === 0) {
    return `${String(counts.untrusted)} of ${String(drawn)} cells are covered by a camera nobody has verified, and none by a trusted one. Every green metre a conventional coverage map would draw here is amber instead.`;
  }
  return `${String(counts.trusted)} trusted and ${String(counts.untrusted)} untrusted cells. The amber area is the coverage a map without a trust filter would have shown as green.`;
}
