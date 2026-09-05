'use client';

/**
 * The impossible-transition investigation view (D3-02).
 *
 * A finding here is the most consequential thing this product says: *two sightings of one
 * registration cannot both be the same vehicle*. It is one step from an accusation, and the whole
 * design of this panel is about not taking that step for the officer reading it.
 *
 * Four rules, and every one of them is visible in the markup rather than in a comment:
 *
 *  1. **The two crops sit side by side, at equal weight.** The panel's entire job is to let a human
 *     compare two images and decide. Neither side is styled as the "suspect" one — they are `left`
 *     and `right`, in the order the vehicle was seen, with the same frame and the same caption
 *     fields. When a crop is missing the panel says so in words instead of showing an empty box,
 *     because a blank frame reads as "no evidence found" rather than "no image was kept".
 *  2. **The verdict never arrives alone.** `headline`, `why` and `alternativeExplanation` are all
 *     required by the API type, and all three are rendered together. There is no state of this
 *     component in which a reader sees "likely cloned" without also seeing what else would look
 *     exactly like it.
 *  3. **The arithmetic is shown, not summarised.** Elapsed time, road distance, the free-flow
 *     estimate and the minimum average speed are on screen, with the word **minimum** — because the
 *     road distance is the fastest path, so the speed is a lower bound, and a reader who thinks it
 *     is an estimate will over-read every number beside it.
 *  4. **`matchDistance` is never rendered alone or as an integer** (D2-04). The candidate
 *     alternative plate is shown as a plate with its note; the weighted distance appears only as a
 *     three-decimal figure beside the string it belongs to.
 *
 * `feasible` and `indeterminate` findings are not listed. They are the overwhelming majority on a
 * real estate and a panel full of "nothing wrong here" rows would bury the two that matter — the
 * count of what was assessable is in the header instead, so nothing is hidden by being omitted.
 */
import type { TracePayload } from './types';

type Route = NonNullable<TracePayload['route']>;
type AnomalyReport = Route['anomalies'];
type Finding = AnomalyReport['findings'][number];
type EvidenceSide = NonNullable<Finding['alert']>['evidence']['left'];

const EXPLANATION_LABEL: Record<Finding['explanation'], string> = {
  likely_misread: 'Most likely a misread',
  likely_cloned: 'Most likely a duplicated registration',
  undetermined: 'Undetermined',
};

const EXPLANATION_TONE: Record<Finding['explanation'], string> = {
  likely_misread: 'border-sky-800 bg-sky-950/40 text-sky-200',
  likely_cloned: 'border-amber-700 bg-amber-950/40 text-amber-200',
  undetermined: 'border-slate-700 bg-slate-900/60 text-slate-300',
};

const TEST_LABEL: Record<Finding['failedTests'][number], string> = {
  minimum_average_speed: 'the minimum average speed exceeds the plausible ceiling',
  faster_than_free_flow: 'the trip beat the road graph’s free-flow time for the fastest path',
};

export function CloningPanel({ anomalies }: { anomalies: AnomalyReport }) {
  const impossible = anomalies.findings.filter((f) => f.feasibility === 'impossible');

  return (
    <section
      className="rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3"
      data-testid="cloning-panel"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
          Impossible transitions
        </h2>
        <p className="text-[11px] text-slate-500 tabular-nums">
          {anomalies.segmentsEvaluable} of {anomalies.segmentsExamined} transition
          {anomalies.segmentsExamined === 1 ? '' : 's'} assessable · ceiling{' '}
          {anomalies.policy.maxPlausibleKmh} km/h
        </p>
      </div>

      {impossible.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400" data-testid="cloning-empty">
          {anomalies.segmentsEvaluable === 0
            ? 'No transition on this route could be assessed: a road distance is needed between two ' +
              'placed cameras, and none of these pairs has one. That is not a finding that the ' +
              'route is consistent.'
            : 'No transition on this route requires a speed the road cannot support. The distance ' +
              'used is the fastest path, which is a lower bound on the distance driven — so this ' +
              'is “not shown to be impossible”, not a verification.'}
        </p>
      ) : (
        <ul className="mt-3 space-y-4" data-testid="cloning-findings">
          {impossible.map((finding) => (
            <FindingRow key={finding.seq} finding={finding} />
          ))}
        </ul>
      )}

      <p className="mt-3 border-t border-slate-800 pt-2 text-[11px] text-slate-500">
        {anomalies.disclaimer}
      </p>
    </section>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <li
      className="rounded-md border border-slate-800 bg-slate-950/40 p-3"
      data-testid="cloning-finding"
      data-explanation={finding.explanation}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${EXPLANATION_TONE[finding.explanation]}`}
          data-testid="cloning-verdict"
        >
          {EXPLANATION_LABEL[finding.explanation]}
        </span>
        <span className="text-xs text-slate-300 tabular-nums">
          {finding.fromCameraName} → {finding.toCameraName}
        </span>
        {finding.repeatedPairs > 1 ? (
          <span className="text-[10px] text-slate-400 tabular-nums">
            seen {finding.repeatedPairs}× on this pair
          </span>
        ) : null}
      </div>

      {/* Rule 2 — the verdict, the reason and the alternative, always together. */}
      <p className="mt-2 text-xs text-slate-200">{finding.headline}</p>
      <p className="mt-1 text-xs text-slate-400">{finding.why}</p>
      <p className="mt-1 text-xs text-slate-400" data-testid="cloning-alternative">
        {finding.alternativeExplanation}
      </p>

      {/* Rule 3 — the arithmetic, with the word "minimum" doing real work. */}
      <dl
        className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4"
        data-testid="cloning-arithmetic"
      >
        <Figure label="Elapsed" value={`${finding.elapsedSeconds.toFixed(0)} s`} />
        <Figure
          label="Road distance"
          value={finding.roadDistanceKm === null ? '—' : `${finding.roadDistanceKm.toFixed(2)} km`}
        />
        <Figure
          label="Free-flow needs"
          value={
            finding.expectedTravelTimeS === null
              ? '—'
              : `${finding.expectedTravelTimeS.toFixed(0)} s`
          }
        />
        <Figure
          label="Minimum average"
          value={
            finding.minimumAverageSpeedKmh === null
              ? '—'
              : `${finding.minimumAverageSpeedKmh.toFixed(0)} km/h`
          }
        />
      </dl>
      <p className="mt-1 text-[11px] text-slate-500">
        Failed {finding.failedTests.length === 1 ? 'check' : 'checks'}:{' '}
        {finding.failedTests.map((t) => TEST_LABEL[t]).join('; ')}.
      </p>

      {/* Rule 4 — the candidate alternative, never a bare distance. */}
      {finding.candidateAlternative !== null ? (
        <p className="mt-2 text-xs text-slate-300" data-testid="cloning-candidate">
          Candidate alternative:{' '}
          <span className="font-semibold text-sky-200">{finding.candidateAlternative.plate}</span>{' '}
          <span className="text-slate-500 tabular-nums">
            (weighted distance {finding.candidateAlternative.distance.toFixed(3)}
            {finding.candidateAlternative.tailChars > 0
              ? `, ${finding.candidateAlternative.tailChars} truncated`
              : ''}
            )
          </span>{' '}
          <span className="text-slate-400">{finding.candidateAlternative.note}</span>
        </p>
      ) : null}

      {/* Rule 1 — the two crops, side by side, at equal weight. */}
      {finding.alert !== null ? (
        <div className="mt-3" data-testid="cloning-alert" data-severity={finding.alert.severity}>
          <p className="text-[11px] font-semibold tracking-wide text-amber-300 uppercase">
            Escalated · severity {finding.alert.severity}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-3" data-testid="cloning-crops">
            <CropSide side={finding.alert.evidence.left} which="left" />
            <CropSide side={finding.alert.evidence.right} which="right" />
          </div>
          {finding.alert.cropsIncomplete ? (
            <p className="mt-2 text-[11px] text-slate-400" data-testid="cloning-crops-incomplete">
              No stored crop for at least one of the two reads, so the images cannot be compared
              here. The timing evidence stands on its own; the visual comparison does not.
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="mt-2 text-[11px] text-slate-500">{finding.limitations}</p>
    </li>
  );
}

function CropSide({ side, which }: { side: EvidenceSide; which: 'left' | 'right' }) {
  return (
    <figure data-testid={`cloning-crop-${which}`} className="min-w-0">
      {side.cropUrl === null ? (
        <div className="flex h-24 items-center justify-center rounded border border-dashed border-slate-700 px-2 text-center text-[10px] text-slate-500">
          No crop kept for this read
        </div>
      ) : (
        // A plain <img>, not next/image: a presigned object-store URL is time-limited, minted per
        // request and served from MinIO, so there is nothing for the image optimiser to cache.
        <img
          src={side.cropUrl}
          alt={`Plate crop read as ${side.plateNormalized} at ${side.cameraName}`}
          className="h-24 w-full rounded border border-slate-700 object-cover"
        />
      )}
      <figcaption className="mt-1 text-[11px] text-slate-400">
        <span className="block font-medium text-slate-200">{side.cameraName}</span>
        <span className="block tabular-nums">{new Date(side.ts).toLocaleString()}</span>
        <span className="block tabular-nums">
          read <span className="text-slate-200">{side.plateNormalized}</span> · OCR{' '}
          {side.ocrConfidence.toFixed(2)} · link {side.linkConfidence.toFixed(2)}
        </span>
        <span className="block">
          {side.grammarValid ? 'valid under the plate grammar' : 'not a valid registration format'}
        </span>
      </figcaption>
    </figure>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-200 tabular-nums">{value}</dd>
    </div>
  );
}
