/**
 * Band presentation — the one place a trust band becomes a colour.
 *
 * ## The rule this module exists to enforce
 *
 * **The band is never computed here.** It arrives on `CameraResponse.band`, resolved by the API
 * from the *latest health check*, and every function below is a lookup keyed on that value. D1-06's
 * handoff is blunt about why: an unreachable camera keeps its last good score, because a camera
 * that answered nothing has no signals to compute a new number from. A map that ran
 * `trustScore >= 70` itself would paint a camera that went dark yesterday green — which is exactly
 * the false assurance Pillar 1 exists to remove.
 *
 * `registry.test.ts` asserts that no numeric threshold appears in the paint expression this module
 * produces, so the rule survives a future edit rather than depending on somebody remembering it.
 *
 * ## Five values, not four
 *
 * `band === null` means **never probed**, and it is rendered as its own thing. D1-02's handoff:
 * *"`trustScore: null` means never probed and matches neither `trustMin` nor `trustMax`. The map
 * must render *unknown* differently from *low*."* So `unscored` is a **hollow ring** — a different
 * shape, not merely a paler shade of the bad colour — because "we have never measured this" and
 * "we measured it and it is bad" are different findings and the registry's whole job is to keep
 * them apart.
 */

/** The four bands the API resolves. Mirrors `TrustBand` in `camera-contracts.ts`. */
export const TRUST_BANDS = ['trusted', 'degraded', 'untrusted', 'dead'] as const;
export type TrustBand = (typeof TRUST_BANDS)[number];

/** What the UI keys on: the four bands plus the never-probed case. */
export const BAND_KEYS = [...TRUST_BANDS, 'unscored'] as const;
export type BandKey = (typeof BAND_KEYS)[number];

export function isBandKey(value: string): value is BandKey {
  return (BAND_KEYS as readonly string[]).includes(value);
}

/** `null` from the API is `unscored`. This is the only mapping; nothing else derives a band. */
export function bandKeyOf(band: TrustBand | null | undefined): BandKey {
  return band ?? 'unscored';
}

export interface BandStyle {
  /** Pin fill. `null` renders as a hollow ring — see the module note. */
  readonly fill: string | null;
  readonly stroke: string;
  readonly label: string;
  /** What the colour actually asserts. Shown in the legend, because a colour alone lies. */
  readonly meaning: string;
  /** Tailwind classes for chips in the table, tray and drawer. */
  readonly chip: string;
}

export const BAND_STYLE: Record<BandKey, BandStyle> = {
  trusted: {
    fill: '#10b981',
    stroke: '#065f46',
    label: 'Trusted',
    meaning: 'Reachable, and every measured signal is within tolerance.',
    chip: 'border-emerald-800 bg-emerald-950/60 text-emerald-300',
  },
  degraded: {
    fill: '#f59e0b',
    stroke: '#78350f',
    label: 'Degraded',
    meaning:
      'Reachable, but a measured signal is out of tolerance. Not the same as usable — cam22 sits here while being effectively blind.',
    chip: 'border-amber-800 bg-amber-950/60 text-amber-300',
  },
  untrusted: {
    fill: '#ef4444',
    stroke: '#7f1d1d',
    label: 'Untrusted',
    meaning: 'Reachable, and measured badly enough that evidence from it should be questioned.',
    chip: 'border-rose-800 bg-rose-950/60 text-rose-300',
  },
  dead: {
    fill: '#1e293b',
    stroke: '#ef4444',
    label: 'Dead',
    meaning:
      'The last probe could not connect. Resolved from that probe, not from the stored score, which is still whatever it was when the camera last answered.',
    chip: 'border-rose-900 bg-slate-900 text-rose-400',
  },
  unscored: {
    fill: null,
    stroke: '#94a3b8',
    label: 'Never probed',
    meaning:
      'No health check has ever run against this camera. This is an absence of evidence, not a bad result — deliberately drawn as a hollow ring so it cannot be misread as a low score.',
    chip: 'border-slate-700 bg-slate-800/60 text-slate-400',
  },
};

/**
 * The MapLibre `match` expression for pin fill, built from `BAND_STYLE`.
 *
 * Keyed on the feature's `band` property — which is the API's value, copied verbatim — so there is
 * no arithmetic anywhere in the paint. `unscored` gets a transparent fill; its ring comes from the
 * stroke expression.
 */
export function bandFillExpression(): unknown[] {
  return [
    'match',
    ['get', 'band'],
    ...BAND_KEYS.flatMap((key) => [key, BAND_STYLE[key].fill ?? 'rgba(0,0,0,0)']),
    '#64748b',
  ];
}

export function bandStrokeExpression(): unknown[] {
  return [
    'match',
    ['get', 'band'],
    ...BAND_KEYS.flatMap((key) => [key, BAND_STYLE[key].stroke]),
    '#64748b',
  ];
}

/** Hollow ring for `unscored`, solid disc for everything else. */
export function bandStrokeWidthExpression(): unknown[] {
  return ['match', ['get', 'band'], 'unscored', 2, 'dead', 2, 1];
}

export function bandStyleOf(band: TrustBand | null | undefined): BandStyle {
  return BAND_STYLE[bandKeyOf(band)];
}

/**
 * Presence in the upstream catalogue.
 *
 * D1-04's handoff: *"`catalogue_status` is presence; `status` is health. Independent by design …
 * Do not merge them into one UI badge."* Two separate lookups, rendered as two separate chips,
 * because a camera can be listed and dead, or delisted and still serving.
 */
export const CATALOGUE_STATUS_CHIP: Record<string, string> = {
  active: 'border-sky-900 bg-sky-950/50 text-sky-300',
  absent: 'border-amber-900 bg-amber-950/50 text-amber-300',
};

/** Measured health, owned by the prober. Nothing to do with the band or with catalogue presence. */
export const HEALTH_STATUS_CHIP: Record<string, string> = {
  unknown: 'border-slate-700 bg-slate-800/60 text-slate-400',
  online: 'border-emerald-800 bg-emerald-950/60 text-emerald-300',
  degraded: 'border-amber-800 bg-amber-950/60 text-amber-300',
  offline: 'border-rose-800 bg-rose-950/60 text-rose-300',
};
