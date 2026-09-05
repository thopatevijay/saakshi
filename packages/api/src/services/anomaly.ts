/**
 * Impossible-transition detection — plate cloning, or an OCR error (D3-02).
 *
 * If a registration is read at two cameras separated by more road than the elapsed time can cover,
 * exactly one of two things happened: the camera misread a plate, or two vehicles are wearing the
 * same one. Vehicle cloning is widespread in India and largely undetected, because nothing
 * cross-checks a registration against the physics of where it has been. This file does that check
 * and then does the harder half — it says which explanation the evidence favours, and refuses to
 * say more than the evidence supports.
 *
 * ## The bound direction, which is the whole detector
 *
 * `roadDistanceKm` is OSRM's **fastest** path, so it is a **lower bound** on the distance actually
 * driven. It follows that `roadDistanceKm / elapsed` is a **lower bound on the average speed** —
 * the vehicle averaged *at least* that — and that `expectedTravelTimeS` is a **lower bound on the
 * time the trip needs**. Both inequalities point the same way, and that way is the one this ticket
 * needs: a transition is impossible only when even the *most generous* reading of the evidence
 * demands something unreachable.
 *
 * The converse is not a clean bill of health, and this file never reports it as one. A transition
 * that looks fine against the fastest path may still be impossible on the road the vehicle really
 * took; `feasible` here means "not shown to be impossible", which is a weaker and more honest claim.
 *
 * D2-08's `TraceSegment.impliedSpeedKmh` documents the same physical quantity as an **upper** bound.
 * It is not used here and must not be: applied in that direction the test inverts, clearing real
 * cloning and flagging legitimate travel. D3-01 named its own field `minimumAverageSpeedKmh` so the
 * two cannot be confused (issue #25).
 *
 * ## What is even eligible
 *
 * Only `inferred_path` segments. The other three kinds carry no computable distance and `null` is
 * load-bearing — it means "cannot be computed", never 0:
 *
 *  - `observed_dwell` — one camera held the vehicle in an unbroken ByteTrack session. The movement
 *    was on video; there is nothing to disbelieve.
 *  - `inferred_revisit` — the same camera, a different tracking session. The vehicle left and came
 *    back, and where it went is unbounded, so no speed exists to be impossible.
 *  - `inferred_unroutable` — a camera has no coordinates, or the graph has no path. **This is the
 *    normal case on the real estate**: the Sentinel catalogue publishes `{id, name}` only, so 0 of
 *    30 real cameras are placed. Treating a null expectation as 0 would make every one of those hops
 *    infinitely fast and manufacture cloning alerts out of the entire estate.
 *
 * ## Misread or clone
 *
 * The two explanations are told apart by four signals, every one of them already measured elsewhere
 * in this codebase rather than invented here:
 *
 *  1. **OCR confidence at each end.** The estate's legible reads were measured at 0.449–0.732
 *     (D2-01), so the thresholds in `config/anomaly-policy.json` straddle that range rather than
 *     sitting at a comfortable 0.9 the estate would never reach.
 *  2. **The weighted distance between the two reads** under D2-04's confusion metric — fractional
 *     and slot-aware, never Levenshtein and never bucketed to an integer. Two reads a single
 *     confusable substitution apart are one plate read twice; two *identical* reads leave nothing
 *     for OCR to have got wrong.
 *  3. **Truncation.** `WeightedDistance.tailChars` says how much of that distance was a clean
 *     prefix rather than a substitution. A truncated read is the same vehicle read badly — this
 *     estate's dominant failure — and is a misread every time.
 *  4. **Grammar.** A read D2-03's grammar refuses is not a registration under any Indian layout,
 *     and cannot be evidence that a registration is duplicated.
 *
 * A clone verdict additionally requires the pattern to **repeat**, because cloning is a standing
 * arrangement and an OCR accident is not. When nothing decides it, the verdict is `undetermined` —
 * a real third state, not a euphemism for clean.
 *
 * ## What this can never say
 *
 * There is **no live VAHAN or SARTHI connectivity** in this system, so nothing here can confirm that
 * a registration exists, that it is validly issued, or who holds it. The strongest available claim
 * is *"these two sightings are inconsistent with a single vehicle"*, and every rendered string in
 * this file states the innocent explanation beside the guilty one. `anomaly.test.ts` asserts that
 * mechanically over every string the module can produce.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AlertSeverity, validate } from '@saakshi/shared';
import type { RouteSegment } from './route.js';
import type { TraceSighting } from './trace.js';
import { loadConfusions, weightedDistance, type ConfusionConfig } from './plate-search.js';

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/* Policy                                                                                          */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

export const AnomalyPolicy = z
  .object({
    version: z.number().int(),
    speed: z
      .object({
        /** Fastest sustained average this detector concedes, km/h. A physical ceiling. */
        maxPlausibleKmh: z.number().positive(),
        /** How far below OSRM's free-flow duration is still driving. 1.35 = 35 % faster. */
        graphSpeedTolerance: z.number().min(1),
        /** Below this the gap is PTS quantisation, not travel. Guard, not tolerance. */
        minElapsedSeconds: z.number().nonnegative(),
      })
      .loose(),
    disambiguation: z
      .object({
        highOcrConfidence: z.number().min(0).max(1),
        lowOcrConfidence: z.number().min(0).max(1),
        /** D2-04's ceiling. Above 2 unrelated plates start matching — never raise this. */
        maxNeighbourDistance: z.number().min(0).max(2),
        truncationDominanceRatio: z.number().min(0).max(1),
        repeatPairsForClone: z.number().int().positive(),
      })
      .loose(),
    alert: z
      .object({
        severity: AlertSeverity,
        minLinkConfidence: z.number().min(0).max(1),
        cropUrlExpiresInS: z.number().int().positive(),
      })
      .loose(),
  })
  .loose();
export type AnomalyPolicy = z.infer<typeof AnomalyPolicy>;

export const ANOMALY_POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../config/anomaly-policy.json',
);

let cachedPolicy: AnomalyPolicy | undefined;

/**
 * Loads the policy from `config/anomaly-policy.json`.
 *
 * Read from disk rather than imported, for the reason `loadAlertPolicy` is: the acceptance
 * criterion is that changing the speed tolerance moves the boundary **with no code change**, and a
 * bundled import would make the policy a build input instead.
 */
export function loadAnomalyPolicy(configPath: string = ANOMALY_POLICY_PATH): AnomalyPolicy {
  if (configPath === ANOMALY_POLICY_PATH && cachedPolicy !== undefined) return cachedPolicy;
  const parsed = AnomalyPolicy.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  if (configPath === ANOMALY_POLICY_PATH) cachedPolicy = parsed;
  return parsed;
}

/** Test seam. The policy is cached per-process; a test that writes a policy file must clear it. */
export function clearAnomalyPolicyCache(): void {
  cachedPolicy = undefined;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/* Shapes                                                                                          */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * `impossible` — even the lower-bound reading of the evidence demands something unreachable.
 * `feasible` — **not shown to be impossible**, which is weaker than "fine". The real road is longer
 *   than OSRM's fastest path, so a segment can pass this test and still not have happened.
 * `indeterminate` — no distance or no usable elapsed time. The normal state on the real estate,
 *   where no camera is placed. Never silently folded into `feasible`.
 */
export type TransitionFeasibility = 'impossible' | 'feasible' | 'indeterminate';

/** Which of the two explanations the evidence favours, or neither. */
export type AnomalyExplanation = 'likely_misread' | 'likely_cloned' | 'undetermined';

/** Which of the two feasibility tests fired. Both point the same way; they catch different cases. */
export type FeasibilityTest = 'minimum_average_speed' | 'faster_than_free_flow';

export interface CandidateAlternative {
  /** The other endpoint's normalised read — the plate this one may actually have been. */
  plate: string;
  /** D2-04's weighted distance. Fractional and slot-aware. Never render it on its own. */
  distance: number;
  /** How many of those units came from truncation rather than substitution. */
  tailChars: number;
  /** `true` when truncation dominates: a clean prefix, so the same vehicle read badly. */
  truncation: boolean;
  /** Which end carries the read that is more likely to be wrong — the lower-confidence one. */
  weakerEndpoint: 'from' | 'to';
  note: string;
}

export interface AnomalyEvidenceSide {
  sightingId: string;
  ts: string;
  cameraId: string;
  cameraName: string;
  plateNormalized: string;
  plateRawText: string;
  ocrConfidence: number;
  linkMethod: TraceSighting['linkMethod'];
  linkConfidence: number;
  grammarValid: boolean;
  /** `s3://bucket/key`, as stored. */
  cropUri: string | null;
  /** Time-limited HTTP URL for the crop, or `null` when no object store is configured. */
  cropUrl: string | null;
}

export interface CloningAlert {
  kind: 'cloned_plate_suspected';
  severity: AnomalyPolicy['alert']['severity'];
  plate: string;
  /** Deliberately two named sides rather than an array: the view is side-by-side, not a list. */
  evidence: { left: AnomalyEvidenceSide; right: AnomalyEvidenceSide };
  /** `true` when at least one side has no crop. The panel says so rather than showing a gap. */
  cropsIncomplete: boolean;
  headline: string;
  why: string;
  alternativeExplanation: string;
  limitations: string;
}

export interface AnomalyFinding {
  /** `RouteSegment.seq`. The join back onto the reconstruction. */
  seq: number;
  fromSightingId: string;
  toSightingId: string;
  fromCameraName: string;
  toCameraName: string;

  feasibility: TransitionFeasibility;
  /** The enum value written to `route_segments.anomaly`. */
  anomaly: 'none' | 'impossible_transition';
  /** Which tests fired. Empty unless `feasibility === 'impossible'`. */
  failedTests: FeasibilityTest[];

  elapsedSeconds: number;
  /** OSRM's fastest path. A LOWER bound on the distance driven. */
  roadDistanceKm: number | null;
  /** Free-flow duration for that path. A LOWER bound on the time the trip needs. */
  expectedTravelTimeS: number | null;
  /** `roadDistanceKm / elapsed`. A LOWER bound: the vehicle averaged at least this. */
  minimumAverageSpeedKmh: number | null;
  /** How much of the free-flow time the vehicle used. < 1 means it beat the fastest path. */
  elapsedVsExpected: number | null;

  explanation: AnomalyExplanation;
  /** The plate the weaker read may actually have been. `null` when the two reads are identical. */
  candidateAlternative: CandidateAlternative | null;
  /** How many impossible transitions in this trace share this camera pair and these reads. */
  repeatedPairs: number;
  /** Geometric mean of the two link confidences — how strongly this pair is tied to the plate. */
  linkConfidence: number;

  headline: string;
  why: string;
  alternativeExplanation: string;
  limitations: string;
  /** Present only when the verdict is `likely_cloned` and the links clear the policy floor. */
  alert: CloningAlert | null;
}

export interface AnomalyReport {
  plate: string;
  segmentsExamined: number;
  /** Of those, how many carried a road distance and a usable elapsed time. */
  segmentsEvaluable: number;
  impossible: number;
  likelyMisread: number;
  likelyCloned: number;
  undetermined: number;
  alerts: number;
  findings: AnomalyFinding[];
  policy: { maxPlausibleKmh: number; graphSpeedTolerance: number; version: number };
  /** Rendered above the list. Says what the numbers are and are not. */
  disclaimer: string;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/* Copy — every rendered string this module can produce lives here                                 */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The copy, in one object so a test can walk all of it.
 *
 * AC 7 is *"output language never claims certainty — asserted by a copy test on the rendered
 * strings"*. That is only assertable if the strings are enumerable, so nothing in this file builds a
 * sentence anywhere else. The rule each one keeps: state the observation, name the innocent
 * explanation, and never name a crime.
 */
export const ANOMALY_COPY = {
  disclaimer:
    'A finding here is not an accusation. It says two sightings are inconsistent with a single ' +
    'vehicle, and no more than that. This system has no link to VAHAN or SARTHI, so it cannot ' +
    'confirm that a registration exists, that it was validly issued, or who holds it. Every ' +
    'finding is served with the innocent explanation beside it, and both should be checked.',

  impossibleHeadline:
    'Physically impossible transition — the fastest road between these two cameras cannot be ' +
    'driven in the time between the two reads.',

  feasible:
    'Not shown to be impossible. The elapsed time is compatible with the fastest road path, which ' +
    'is a lower bound on the distance actually driven — a longer real route could still make this ' +
    'transition impossible, so this is not a clean bill of health.',

  indeterminate:
    'Cannot be assessed. No road distance is available for this pair, so no travel time can be ' +
    'required and nothing can be called impossible. On this estate that is the ordinary case: the ' +
    'camera catalogue publishes an identifier and a name only, so most cameras have no coordinates.',

  misreadHeadline: 'Most likely cause: one of the two plates was misread.',
  misreadWhy:
    'The two reads are not the same string, and they are close enough under the confusion-aware ' +
    'metric that one is a plausible misreading of the other, or at least one read carries low OCR ' +
    'confidence. An impossible transition between two reads that differ is more often a camera ' +
    'error than two vehicles.',
  misreadAlternative:
    'It remains possible that the plate is duplicated and that the difference between the reads is ' +
    'coincidental. Compare the two crops before ruling either explanation out.',

  clonedHeadline:
    'Most likely cause: the same registration appears to be in use on more than one vehicle.',
  clonedWhy:
    'Both reads are the same string, both carry OCR confidence in the upper part of this estate’s ' +
    'measured range, both are valid under the Indian plate grammar, and the pattern repeats across ' +
    'more than one pair of sightings. There is little left for the camera to have got wrong.',
  clonedAlternative:
    'A repeated OCR failure that lands on the same wrong string at both cameras would look ' +
    'identical to this, and so would a mis-tracked pass in which two vehicles were joined into one ' +
    'sequence — D3-03 measured 21 per cent of tracking passes not holding a single vehicle. ' +
    'Neither can be excluded from the images alone.',

  undeterminedHeadline:
    'Most likely cause: undetermined. The transition is impossible, but the evidence does not ' +
    'favour a misread over a duplicated registration.',
  undeterminedWhy:
    'The signals disagree, or too few of them are present to separate the two explanations. This ' +
    'is reported as it stands rather than resolved towards whichever answer is more interesting.',
  undeterminedAlternative:
    'Both explanations remain open. The two crops, side by side, are the evidence an officer needs ' +
    'to judge which is which.',

  limitations:
    'Limits of this finding: the road distance is the fastest path the graph knows, not the road ' +
    'taken; the time comes from the video presentation clock, so a camera whose clock is wrong ' +
    'produces this signature without any vehicle doing anything; and the link from each sighting ' +
    'to this registration is itself a match, not a certainty.',

  candidateNote:
    'The other camera read this plate differently. The alternative shown is that other read, ' +
    'offered as the string this one may actually have been — not as a correction.',
  truncationNote:
    'One read is a clean prefix of the other, which is this estate’s most common failure: the ' +
    'same plate, one camera seeing fewer characters. That points to a misread rather than to two ' +
    'vehicles.',

  cropsIncomplete:
    'No stored crop for at least one of the two reads, so the images cannot be compared here. The ' +
    'timing evidence stands on its own; the visual comparison does not.',
} as const;

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/* Feasibility                                                                                     */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

export interface FeasibilityVerdict {
  feasibility: TransitionFeasibility;
  failedTests: FeasibilityTest[];
}

/**
 * Is this transition possible at all?
 *
 * Two tests, both on the lower-bound side, and failing **either** is enough:
 *
 *  1. `minimumAverageSpeedKmh > maxPlausibleKmh` — the least speed the vehicle can have averaged
 *     is already above the fastest sustained average this policy concedes.
 *  2. `elapsed × graphSpeedTolerance < expectedTravelTimeS` — the vehicle beat the road graph's
 *     free-flow estimate for the *fastest* path by more than the tolerance. Free-flow already
 *     assumes no traffic, no signals and no stops.
 *
 * The second catches what the first cannot: a short urban hop where the absolute speed stays
 * ordinary but the road simply does not go that way. The first catches what the second cannot: a
 * graph whose free-flow estimate is optimistic over a long distance.
 *
 * Anything without a road distance, or with an elapsed time below the quantisation guard, is
 * `indeterminate`. It is never `feasible`, because nothing was tested.
 */
export function assessFeasibility(
  segment: Pick<
    RouteSegment,
    'kind' | 'sameCamera' | 'elapsedSeconds' | 'roadDistanceKm' | 'expectedTravelTimeS'
  >,
  policy: AnomalyPolicy,
): FeasibilityVerdict {
  // Only a routed transition between two different placed cameras claims a distance at all.
  if (segment.kind !== 'inferred_path' || segment.sameCamera) {
    return { feasibility: 'indeterminate', failedTests: [] };
  }
  const { roadDistanceKm, expectedTravelTimeS, elapsedSeconds } = segment;
  if (roadDistanceKm === null || expectedTravelTimeS === null) {
    return { feasibility: 'indeterminate', failedTests: [] };
  }

  const failed: FeasibilityTest[] = [];
  // The quantisation guard applies to this test **only**, because this is the one that divides by
  // the elapsed time. Below the guard the denominator is dominated by frame cadence rather than by
  // travel, and a speed computed from it is arithmetic rather than evidence.
  if (elapsedSeconds >= policy.speed.minElapsedSeconds) {
    const minimumAverageSpeedKmh = roadDistanceKm / (elapsedSeconds / 3600);
    if (minimumAverageSpeedKmh > policy.speed.maxPlausibleKmh) failed.push('minimum_average_speed');
  }
  // This one never divides, so it stays available below the guard — and it is exactly there that it
  // matters most. Two seconds against a 420-second free-flow expectation is impossible however
  // coarse the clock is, and D3-01's timing term scores that pair 0.000 for the same reason.
  if (elapsedSeconds * policy.speed.graphSpeedTolerance < expectedTravelTimeS) {
    failed.push('faster_than_free_flow');
  }

  return {
    feasibility: failed.length > 0 ? 'impossible' : 'feasible',
    failedTests: failed,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/* Misread or clone                                                                                */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

export interface Disambiguation {
  explanation: AnomalyExplanation;
  candidateAlternative: CandidateAlternative | null;
}

/**
 * Which explanation the evidence favours.
 *
 * Ordered so the cheap, decisive checks come first and the clone branch is the last one reached —
 * the expensive verdict should be the hardest to arrive at, not the easiest.
 */
export function disambiguate(
  from: TraceSighting,
  to: TraceSighting,
  policy: AnomalyPolicy,
  repeatedPairs: number,
  confusions: ConfusionConfig,
): Disambiguation {
  const d = policy.disambiguation;
  const alternative = candidateFor(from, to, policy, confusions);

  const fromValid = validate(from.plateNormalized).grammarValid;
  const toValid = validate(to.plateNormalized).grammarValid;
  const eitherLow = from.ocrConfidence < d.lowOcrConfidence || to.ocrConfidence < d.lowOcrConfidence;
  const bothHigh =
    from.ocrConfidence >= d.highOcrConfidence && to.ocrConfidence >= d.highOcrConfidence;

  // 1 · A truncated read is the same vehicle read badly. D2-04 measured it as the dominant failure
  //     on this estate and prices it at 0.35/character; it is a misread every time.
  if (alternative !== null && alternative.truncation) {
    return { explanation: 'likely_misread', candidateAlternative: alternative };
  }
  // 2 · Low confidence at either end, or a plausible neighbouring plate within D2-04's budget.
  if (eitherLow || alternative !== null) {
    return { explanation: 'likely_misread', candidateAlternative: alternative };
  }
  // 3 · A read the grammar refuses is not a registration under any Indian layout, so it cannot be
  //     evidence that a registration is duplicated. Not a misread verdict either — it is simply
  //     not a plate, and saying "misread" would imply a correct reading exists.
  if (!fromValid || !toValid) {
    return { explanation: 'undetermined', candidateAlternative: null };
  }
  // 4 · Both reads identical, both confident, both grammatical — and the pattern repeats. Cloning
  //     is a standing arrangement; a single accident is not.
  if (bothHigh && repeatedPairs >= d.repeatPairsForClone) {
    return { explanation: 'likely_cloned', candidateAlternative: null };
  }
  return { explanation: 'undetermined', candidateAlternative: null };
}

/**
 * The plate the weaker read may actually have been.
 *
 * `null` when the two reads are the *same* string — there is nothing for OCR to have got wrong
 * between them — or when they are further apart than D2-04's budget, at which point they are two
 * different plates rather than one read twice.
 *
 * The alternative offered is the *other endpoint's* read, and the endpoint named as weaker is the
 * one with the lower OCR confidence: that is the read more likely to be the wrong one, and the crop
 * an officer should open first.
 */
export function candidateFor(
  from: TraceSighting,
  to: TraceSighting,
  policy: AnomalyPolicy,
  confusions: ConfusionConfig,
): CandidateAlternative | null {
  if (from.plateNormalized === to.plateNormalized) return null;
  if (from.plateNormalized === '' || to.plateNormalized === '') return null;

  const result = weightedDistance(from.plateNormalized, to.plateNormalized, confusions);
  if (result.distance <= 0 || result.distance > policy.disambiguation.maxNeighbourDistance) {
    return null;
  }

  const tailCost = result.ops
    .filter((op) => op.kind === 'tail')
    .reduce((sum, op) => sum + op.cost, 0);
  const truncation =
    result.tailChars > 0 &&
    tailCost >= result.distance * policy.disambiguation.truncationDominanceRatio;

  const weakerEndpoint: 'from' | 'to' = from.ocrConfidence <= to.ocrConfidence ? 'from' : 'to';
  return {
    // The alternative is the *other* read — what the weaker end may actually have been.
    plate: weakerEndpoint === 'from' ? to.plateNormalized : from.plateNormalized,
    distance: result.distance,
    tailChars: result.tailChars,
    truncation,
    weakerEndpoint,
    note: truncation ? ANOMALY_COPY.truncationNote : ANOMALY_COPY.candidateNote,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/* Findings                                                                                        */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Two impossible transitions "repeat" when they join the same camera pair with the same reads. */
function patternKey(from: TraceSighting, to: TraceSighting): string {
  return [from.cameraId, to.cameraId, from.plateNormalized, to.plateNormalized].join(' ');
}

/**
 * Evaluates one reconstructed route against the policy.
 *
 * `sightings` must be the trace's own list, in the trace's own order (`ts ASC, framePtsMs ASC,
 * sightingId ASC`). It is indexed by id and never re-sorted: the order is PTS-derived, and rebuilding
 * it from arrival time would compute impossible velocities after every gateway reconnect.
 */
export function analyseRoute(
  segments: readonly RouteSegment[],
  sightings: readonly TraceSighting[],
  plate: string,
  policy: AnomalyPolicy = loadAnomalyPolicy(),
  confusions: ConfusionConfig = loadConfusions(),
): AnomalyReport {
  const byId = new Map(sightings.map((s) => [s.sightingId, s]));

  // First pass: feasibility only. The repeat count a clone verdict needs is a property of the
  // whole route, so nothing can be disambiguated until every segment has been assessed.
  const assessed = segments.map((segment) => ({
    segment,
    from: byId.get(segment.fromSightingId),
    to: byId.get(segment.toSightingId),
    verdict: assessFeasibility(segment, policy),
  }));

  const repeats = new Map<string, number>();
  for (const row of assessed) {
    if (row.verdict.feasibility !== 'impossible') continue;
    if (row.from === undefined || row.to === undefined) continue;
    const key = patternKey(row.from, row.to);
    repeats.set(key, (repeats.get(key) ?? 0) + 1);
  }

  const findings: AnomalyFinding[] = [];
  for (const { segment, from, to, verdict } of assessed) {
    if (from === undefined || to === undefined) continue;
    const repeatedPairs =
      verdict.feasibility === 'impossible' ? (repeats.get(patternKey(from, to)) ?? 1) : 0;
    findings.push(buildFinding(segment, from, to, verdict, repeatedPairs, policy, confusions));
  }

  const impossible = findings.filter((f) => f.feasibility === 'impossible');
  return {
    plate,
    segmentsExamined: findings.length,
    segmentsEvaluable: findings.filter((f) => f.feasibility !== 'indeterminate').length,
    impossible: impossible.length,
    likelyMisread: impossible.filter((f) => f.explanation === 'likely_misread').length,
    likelyCloned: impossible.filter((f) => f.explanation === 'likely_cloned').length,
    undetermined: impossible.filter((f) => f.explanation === 'undetermined').length,
    alerts: findings.filter((f) => f.alert !== null).length,
    findings,
    policy: {
      maxPlausibleKmh: policy.speed.maxPlausibleKmh,
      graphSpeedTolerance: policy.speed.graphSpeedTolerance,
      version: policy.version,
    },
    disclaimer: ANOMALY_COPY.disclaimer,
  };
}

function buildFinding(
  segment: RouteSegment,
  from: TraceSighting,
  to: TraceSighting,
  verdict: FeasibilityVerdict,
  repeatedPairs: number,
  policy: AnomalyPolicy,
  confusions: ConfusionConfig,
): AnomalyFinding {
  const impossible = verdict.feasibility === 'impossible';
  const { explanation, candidateAlternative } = impossible
    ? disambiguate(from, to, policy, repeatedPairs, confusions)
    : { explanation: 'undetermined' as AnomalyExplanation, candidateAlternative: null };

  // Geometric mean, for D3-01's reason: one weak endpoint should drag the pair down rather than be
  // averaged away by a strong one. An inference between a certainty and a guess is a guess.
  const linkConfidence =
    Math.round(Math.sqrt(clamp01(from.linkConfidence) * clamp01(to.linkConfidence)) * 1000) / 1000;

  const copy = copyFor(verdict.feasibility, explanation);
  const alert =
    impossible && explanation === 'likely_cloned' && linkConfidence >= policy.alert.minLinkConfidence
      ? buildAlert(from, to, policy)
      : null;

  return {
    seq: segment.seq,
    fromSightingId: segment.fromSightingId,
    toSightingId: segment.toSightingId,
    fromCameraName: segment.fromCameraName,
    toCameraName: segment.toCameraName,
    feasibility: verdict.feasibility,
    anomaly: impossible ? 'impossible_transition' : 'none',
    failedTests: verdict.failedTests,
    elapsedSeconds: segment.elapsedSeconds,
    roadDistanceKm: segment.roadDistanceKm,
    expectedTravelTimeS: segment.expectedTravelTimeS,
    minimumAverageSpeedKmh: segment.minimumAverageSpeedKmh,
    elapsedVsExpected: segment.elapsedVsExpected,
    explanation,
    candidateAlternative,
    repeatedPairs,
    linkConfidence,
    headline: copy.headline,
    why: copy.why,
    alternativeExplanation: copy.alternative,
    limitations: ANOMALY_COPY.limitations,
    alert,
  };
}

function copyFor(
  feasibility: TransitionFeasibility,
  explanation: AnomalyExplanation,
): { headline: string; why: string; alternative: string } {
  if (feasibility === 'feasible') {
    return {
      headline: ANOMALY_COPY.feasible,
      why: ANOMALY_COPY.feasible,
      alternative: ANOMALY_COPY.limitations,
    };
  }
  if (feasibility === 'indeterminate') {
    return {
      headline: ANOMALY_COPY.indeterminate,
      why: ANOMALY_COPY.indeterminate,
      alternative: ANOMALY_COPY.limitations,
    };
  }
  const headline = `${ANOMALY_COPY.impossibleHeadline} ${
    explanation === 'likely_misread'
      ? ANOMALY_COPY.misreadHeadline
      : explanation === 'likely_cloned'
        ? ANOMALY_COPY.clonedHeadline
        : ANOMALY_COPY.undeterminedHeadline
  }`;
  switch (explanation) {
    case 'likely_misread':
      return { headline, why: ANOMALY_COPY.misreadWhy, alternative: ANOMALY_COPY.misreadAlternative };
    case 'likely_cloned':
      return { headline, why: ANOMALY_COPY.clonedWhy, alternative: ANOMALY_COPY.clonedAlternative };
    default:
      return {
        headline,
        why: ANOMALY_COPY.undeterminedWhy,
        alternative: ANOMALY_COPY.undeterminedAlternative,
      };
  }
}

/**
 * The cloning alert — its own type, not a row in `alerts`.
 *
 * `alerts` is watchlist-scoped (`watchlist_entry_id NOT NULL`) and says *"this vehicle is wanted"*.
 * This says *"these two sightings cannot both be one vehicle"* — a different claim, resting on
 * different evidence, calling for a different action. Filing it in the operator's watchlist queue
 * would put an accusation where a match belongs. `docs/cloning-detection.md` records the decision.
 *
 * The evidence is deliberately `left`/`right` rather than a list, because the whole point of the
 * investigation view is two crops beside each other for a human to compare.
 */
export function buildAlert(
  from: TraceSighting,
  to: TraceSighting,
  policy: AnomalyPolicy,
): CloningAlert {
  const left = evidenceSide(from);
  const right = evidenceSide(to);
  return {
    kind: 'cloned_plate_suspected',
    severity: policy.alert.severity,
    plate: from.plateNormalized,
    evidence: { left, right },
    cropsIncomplete: left.cropUri === null || right.cropUri === null,
    headline: `${ANOMALY_COPY.impossibleHeadline} ${ANOMALY_COPY.clonedHeadline}`,
    why: ANOMALY_COPY.clonedWhy,
    alternativeExplanation: ANOMALY_COPY.clonedAlternative,
    limitations: ANOMALY_COPY.limitations,
  };
}

function evidenceSide(s: TraceSighting): AnomalyEvidenceSide {
  return {
    sightingId: s.sightingId,
    ts: s.ts,
    cameraId: s.cameraId,
    cameraName: s.cameraName,
    plateNormalized: s.plateNormalized,
    plateRawText: s.plateRawText,
    ocrConfidence: s.ocrConfidence,
    linkMethod: s.linkMethod,
    linkConfidence: s.linkConfidence,
    grammarValid: validate(s.plateNormalized).grammarValid,
    cropUri: s.cropUri,
    cropUrl: s.cropUrl,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
