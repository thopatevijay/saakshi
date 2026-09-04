/**
 * Trust scoring (D1-06).
 *
 * **The score must never be a black box.** Its entire credibility rests on a judge clicking a
 * camera and seeing exactly which signal cost it points — so every function here is deterministic,
 * every weight comes from `config/trust-weights.json`, and the breakdown carries each signal's raw
 * value, its weight and its point contribution. The points sum to the score, and a test asserts it.
 *
 * ## The rule that shapes everything else
 *
 * **A signal that cannot be judged is excluded from the denominator, never scored zero.**
 *
 * D1-05's handoff is emphatic about why, having been bitten twice: *"`measured_fps IS NULL` means
 * could not measure, never zero… Scoring a null as zero condemns a camera for the network's
 * behaviour."* And separately: *"`pts_drift_ms` means two different things"* — on the VOD sandbox it
 * measures how fast we pulled a file, not a camera's clock.
 *
 * Every sandbox row is VOD, so the clock weight is inapplicable for all thirty cameras. Scored as
 * zero it would silently cost each of them 10 points for being a recording behind a slow link.
 * Excluded and renormalised, it costs them nothing and the score keeps describing the estate rather
 * than our own gateway.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ── Config ──────────────────────────────────────────────────────────────────────────────────────

const SignalWeight = z.object({ weight: z.number().nonnegative() }).loose();

export const TrustWeights = z
  .object({
    version: z.number().int(),
    bands: z.object({ trusted: z.number(), degraded: z.number() }),
    signals: z.object({
      reachability: SignalWeight,
      focus: SignalWeight.extend({
        curve: z.literal('log10'),
        floor: z.number().positive(),
        target: z.number().positive(),
      }),
      light: SignalWeight.extend({
        darkMax: z.number(),
        usableMin: z.number(),
        blownMin: z.number(),
      }),
      tamper: SignalWeight.extend({ cleanMax: z.number(), severeMin: z.number() }),
      frameRate: SignalWeight.extend({
        adequateMin: z.number(),
        unusableMax: z.number(),
        divergencePenalty: z.number().min(0).max(1),
      }),
      clock: SignalWeight.extend({
        driftMaxMs: z.number(),
        applicability: z.enum(['live-only', 'always']),
      }),
    }),
  })
  .loose();

export type TrustWeights = z.infer<typeof TrustWeights>;

const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../config/trust-weights.json',
);

let cached: TrustWeights | undefined;

/**
 * Loads the weights from `config/trust-weights.json`.
 *
 * Read from disk rather than imported, because the acceptance criterion is that **a weight change
 * alters scores with no code change**. A bundled import would make the config a build input.
 */
export function loadWeights(configPath: string = CONFIG_PATH): TrustWeights {
  if (configPath === CONFIG_PATH && cached !== undefined) return cached;
  const parsed = TrustWeights.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  if (configPath === CONFIG_PATH) cached = parsed;
  return parsed;
}

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

/** One health check's signals, as D1-05 measured them. Nulls are meaningful and are preserved. */
export interface HealthSignals {
  connectable: boolean;
  decodable: boolean;
  measuredFps: number | null;
  declaredFps?: number | null;
  fpsDiverged?: boolean;
  blurScore: number | null;
  lumaMean: number | null;
  tamperScore: number | null;
  ptsDriftMs: number | null;
  /** From `breakdown.source_is_vod`. Decides whether the clock signal applies at all. */
  sourceIsVod?: boolean;
}

export type TrustBand = 'trusted' | 'degraded' | 'untrusted' | 'dead';

export interface SignalContribution {
  signal: string;
  /** What was measured. `null` when the signal could not be judged. */
  raw: number | boolean | null;
  /** 0-1 quality. `null` when not applicable — which is why it is not simply 0. */
  quality: number | null;
  weight: number;
  /** Points this signal actually contributed, after renormalisation. Rounded to 2dp. */
  points: number;
  /** The most it could have contributed. 0 when excluded. */
  maxPoints: number;
  applicable: boolean;
  /** Human-readable. This is the sentence the UI shows when a judge asks "why?". */
  note: string;
}

export interface TrustResult {
  score: number;
  band: TrustBand;
  signals: SignalContribution[];
  /** Signals excluded from the denominator, and why. Never silently dropped. */
  excluded: { signal: string; reason: string }[];
  weightsVersion: number;
}

// ── Curves ──────────────────────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo = 0, hi = 1): number => Math.max(lo, Math.min(hi, v));

/**
 * Focus quality on a **log** curve.
 *
 * D1-05's handoff: *"blur 0.011 → 298.6 → 5794.088; five orders of magnitude — do not scale
 * linearly."* On a linear map the estate's own median would land at 5% of full marks and nearly
 * every working camera would read as broken. Log10 puts the median at full marks and still
 * separates the two genuinely blind cameras from the rest.
 */
export function focusQuality(blur: number, floor: number, target: number): number {
  if (blur <= 0) return 0;
  const lo = Math.log10(floor);
  const hi = Math.log10(target);
  if (hi <= lo) return blur >= target ? 1 : 0;
  return clamp((Math.log10(blur) - lo) / (hi - lo));
}

/**
 * Light quality: a usable band, not "is it bright".
 *
 * Zero below `darkMax` (effectively black) and above `blownMin` (a lamp in the lens); full marks
 * between `usableMin` and `blownMin`, with a ramp across the dim gap. The recording runs
 * ~21:00-09:00 and measured night frames sit near luma 90, so this estate is streetlit rather than
 * dark — a curve that punished darkness would condemn most of it for most of its footage.
 */
export function lightQuality(
  luma: number,
  darkMax: number,
  usableMin: number,
  blownMin: number,
): number {
  if (luma <= darkMax || luma >= blownMin) return 0;
  if (luma >= usableMin) return 1;
  return clamp((luma - darkMax) / Math.max(usableMin - darkMax, Number.EPSILON));
}

/** Tamper quality: 1 when clean, ramping to 0 at `severeMin`. Re-derived from measured data. */
export function tamperQuality(tamper: number, cleanMax: number, severeMin: number): number {
  if (tamper <= cleanMax) return 1;
  if (tamper >= severeMin) return 0;
  return clamp(1 - (tamper - cleanMax) / Math.max(severeMin - cleanMax, Number.EPSILON));
}

/** Frame-rate adequacy for multi-frame plate voting, before any divergence penalty. */
export function frameRateQuality(fps: number, unusableMax: number, adequateMin: number): number {
  if (fps <= unusableMax) return 0;
  if (fps >= adequateMin) return 1;
  return clamp((fps - unusableMax) / Math.max(adequateMin - unusableMax, Number.EPSILON));
}

/** Clock quality from absolute drift. Only ever called for a live source — see `score()`. */
export function clockQuality(driftMs: number, maxMs: number): number {
  return clamp(1 - Math.abs(driftMs) / Math.max(maxMs, Number.EPSILON));
}

// ── Bands ───────────────────────────────────────────────────────────────────────────────────────

/**
 * `trusted >= 70 · degraded 40-69 · untrusted < 40 · dead = unreachable`.
 *
 * `dead` is decided before any arithmetic: a camera nobody can reach has no signals to weigh, and
 * giving it a number implies a measurement that never happened.
 *
 * **`reachable` is `connectable`, not `connectable && decodable`.** The ticket defines `dead` as
 * *unreachable*, and the distinction is operational rather than pedantic: a camera that answers but
 * decodes nothing is a stream or codec fault, while one that does not answer at all is a network or
 * power fault. They send different people to different places. The undecodable camera still scores
 * — it lands in `untrusted` on its own merits, at 0 — so nothing is being excused.
 */
export function bandFor(score: number, reachable: boolean, weights: TrustWeights): TrustBand {
  if (!reachable) return 'dead';
  if (score >= weights.bands.trusted) return 'trusted';
  if (score >= weights.bands.degraded) return 'degraded';
  return 'untrusted';
}

// ── The score ───────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  signal: string;
  raw: number | boolean | null;
  quality: number | null;
  weight: number;
  note: string;
  /** False → excluded from the denominator entirely. */
  applicable: boolean;
  excludedReason?: string;
}

export function score(signals: HealthSignals, weights: TrustWeights): TrustResult {
  const w = weights.signals;
  const candidates: Candidate[] = [];

  // ── Reachability ──────────────────────────────────────────────────────────────────────────────
  // Always applicable: it is the one signal that needs no measurement to interpret.
  const reachQuality = !signals.connectable ? 0 : signals.decodable ? 1 : 0;
  candidates.push({
    signal: 'reachability',
    raw: signals.connectable && signals.decodable,
    quality: reachQuality,
    weight: w.reachability.weight,
    applicable: true,
    note: !signals.connectable
      ? 'unreachable — nothing else could be measured'
      : signals.decodable
        ? 'connected and decoding'
        : 'connected but nothing decodable — answering is not the same as being usable',
  });

  // ── Focus ─────────────────────────────────────────────────────────────────────────────────────
  candidates.push(
    signals.blurScore === null
      ? {
          signal: 'focus',
          raw: null,
          quality: null,
          weight: w.focus.weight,
          applicable: false,
          excludedReason: 'no frames decoded, so focus could not be measured',
          note: 'not measured — excluded rather than scored zero',
        }
      : {
          signal: 'focus',
          raw: signals.blurScore,
          quality: focusQuality(signals.blurScore, w.focus.floor, w.focus.target),
          weight: w.focus.weight,
          applicable: true,
          note:
            signals.blurScore < w.focus.floor
              ? `blur ${signals.blurScore} is below the ${String(w.focus.floor)} structure floor — no readable detail`
              : `blur ${signals.blurScore} on a log curve against a ${String(w.focus.target)} target`,
        },
  );

  // ── Light ─────────────────────────────────────────────────────────────────────────────────────
  candidates.push(
    signals.lumaMean === null
      ? {
          signal: 'light',
          raw: null,
          quality: null,
          weight: w.light.weight,
          applicable: false,
          excludedReason: 'no frames decoded, so luma could not be measured',
          note: 'not measured — excluded rather than scored zero',
        }
      : {
          signal: 'light',
          raw: signals.lumaMean,
          quality: lightQuality(
            signals.lumaMean,
            w.light.darkMax,
            w.light.usableMin,
            w.light.blownMin,
          ),
          weight: w.light.weight,
          applicable: true,
          note:
            signals.lumaMean <= w.light.darkMax
              ? `luma ${signals.lumaMean} is effectively black — no plate is readable at any hour`
              : signals.lumaMean >= w.light.blownMin
                ? `luma ${signals.lumaMean} is blown out — a light source is in the lens`
                : `luma ${signals.lumaMean} is in the usable band`,
        },
  );

  // ── Tamper ────────────────────────────────────────────────────────────────────────────────────
  candidates.push(
    signals.tamperScore === null
      ? {
          signal: 'tamper',
          raw: null,
          quality: null,
          weight: w.tamper.weight,
          applicable: false,
          excludedReason: 'fewer than two frames, so no differencing was possible',
          note: 'not measured — excluded rather than scored zero',
        }
      : {
          signal: 'tamper',
          raw: signals.tamperScore,
          quality: tamperQuality(signals.tamperScore, w.tamper.cleanMax, w.tamper.severeMin),
          weight: w.tamper.weight,
          applicable: true,
          note:
            signals.tamperScore >= w.tamper.severeMin
              ? `tamper ${signals.tamperScore} at or past the ${String(w.tamper.severeMin)} severe mark — occluded, frozen or featureless`
              : signals.tamperScore <= w.tamper.cleanMax
                ? 'scene is moving and structured'
                : `tamper ${signals.tamperScore} is elevated`,
        },
  );

  // ── Frame rate ────────────────────────────────────────────────────────────────────────────────
  if (signals.measuredFps === null) {
    // The handoff's first warning, implemented. "Could not measure" is not "runs at zero".
    candidates.push({
      signal: 'frameRate',
      raw: null,
      quality: null,
      weight: w.frameRate.weight,
      applicable: false,
      excludedReason:
        'frame rate could not be measured — usually a throttled upstream, which says nothing about the camera',
      note: 'not measured — excluded rather than scored zero',
    });
  } else {
    const base = frameRateQuality(
      signals.measuredFps,
      w.frameRate.unusableMax,
      w.frameRate.adequateMin,
    );
    const penalised =
      signals.fpsDiverged === true ? base * (1 - w.frameRate.divergencePenalty) : base;
    candidates.push({
      signal: 'frameRate',
      raw: signals.measuredFps,
      quality: penalised,
      weight: w.frameRate.weight,
      applicable: true,
      note:
        signals.fpsDiverged === true
          ? `measured ${signals.measuredFps} fps against a declared ${String(signals.declaredFps ?? '?')} — the registry is wrong, and the score says so`
          : signals.measuredFps < w.frameRate.adequateMin
            ? `${signals.measuredFps} fps is below the ${String(w.frameRate.adequateMin)} fps needed for multi-frame plate voting`
            : `${signals.measuredFps} fps is adequate for multi-frame plate voting`,
    });
  }

  // ── Clock ─────────────────────────────────────────────────────────────────────────────────────
  // The handoff's second warning. On a VOD source this number is pull-rate skew — a property of the
  // network. Scoring it would cost every camera on this estate 10 points for the gateway throttling.
  const clockApplies =
    w.clock.applicability === 'always' ||
    (signals.sourceIsVod !== true && signals.ptsDriftMs !== null);

  candidates.push(
    !clockApplies || signals.ptsDriftMs === null
      ? {
          signal: 'clock',
          raw: signals.ptsDriftMs,
          quality: null,
          weight: w.clock.weight,
          applicable: false,
          excludedReason:
            signals.sourceIsVod === true
              ? 'VOD source: this measures how fast the file was pulled, not the camera clock'
              : 'drift could not be measured',
          note: 'not applicable — excluded rather than scored zero',
        }
      : {
          signal: 'clock',
          raw: signals.ptsDriftMs,
          quality: clockQuality(signals.ptsDriftMs, w.clock.driftMaxMs),
          weight: w.clock.weight,
          applicable: true,
          note: `PTS drifts ${signals.ptsDriftMs} ms from wall clock; a wrong clock corrupts every route this camera contributes to`,
        },
  );

  // ── Renormalise over what can actually be judged ──────────────────────────────────────────────
  const applicable = candidates.filter((c) => c.applicable);
  const denominator = applicable.reduce((sum, c) => sum + c.weight, 0);

  const contributions: SignalContribution[] = candidates.map((c) => {
    const maxPoints = c.applicable && denominator > 0 ? round2((c.weight / denominator) * 100) : 0;
    const points =
      c.applicable && c.quality !== null && denominator > 0
        ? round2((c.weight / denominator) * 100 * c.quality)
        : 0;
    return {
      signal: c.signal,
      raw: c.raw,
      quality: c.quality === null ? null : round2(c.quality),
      weight: c.weight,
      points,
      maxPoints,
      applicable: c.applicable,
      note: c.note,
    };
  });

  // Summed from the rounded contributions, not computed separately, so the breakdown provably adds
  // up to the score rather than approximately agreeing with it.
  const raw = contributions.reduce((sum, c) => sum + c.points, 0);
  const total = denominator === 0 ? 0 : round2(raw);

  return {
    score: total,
    band: bandFor(total, signals.connectable, weights),
    signals: contributions,
    excluded: candidates
      .filter((c) => !c.applicable)
      .map((c) => ({ signal: c.signal, reason: c.excludedReason ?? 'not applicable' })),
    weightsVersion: weights.version,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Reads D1-05's `breakdown` jsonb into the scorer's input shape. */
export function signalsFromRow(row: {
  connectable: boolean;
  decodable: boolean;
  measuredFps: number | null;
  blurScore: number | null;
  lumaMean: number | null;
  tamperScore: number | null;
  ptsDriftMs: number | null;
  breakdown: unknown;
}): HealthSignals {
  const breakdown = (row.breakdown ?? {}) as Record<string, unknown>;
  const fps = (breakdown['fps'] ?? {}) as Record<string, unknown>;
  return {
    connectable: row.connectable,
    decodable: row.decodable,
    measuredFps: row.measuredFps,
    declaredFps: typeof fps['declared'] === 'number' ? fps['declared'] : null,
    fpsDiverged: fps['diverged'] === true,
    blurScore: row.blurScore,
    lumaMean: row.lumaMean,
    tamperScore: row.tamperScore,
    ptsDriftMs: row.ptsDriftMs,
    sourceIsVod: breakdown['source_is_vod'] === true,
  };
}
