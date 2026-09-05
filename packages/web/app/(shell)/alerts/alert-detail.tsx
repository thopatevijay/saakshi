'use client';

/**
 * The expanded row: everything needed to *disagree* with the machine.
 *
 * The queue's job is a three-second verdict. This panel's job is the opposite — it is where an
 * officer who is not satisfied goes to argue, and where a judge looks to see whether the system can
 * justify what it just claimed. So it shows the whole `reason` payload in the API's own words
 * rather than a summary of it:
 *
 *   - **`caveats` verbatim, never summarised.** D2-06 writes them for the officer's eye and they are
 *     never empty. Even a perfect exact match carries the mock-provider disclaimer, because the one
 *     claim that must never be implied is that VAHAN answered.
 *   - **The watchlist record with its provenance.** Five of the seven alerts on this estate match
 *     entries whose own note says *"SELECTED FROM MEASURED ANPR OUTPUT, NOT FROM A VEHICLE
 *     REGISTRY"*. That note is shown, and so is the literal `live: false`.
 *   - **The severity derivation**, including every ceiling that fired. An officer who sees `high`
 *     lowered to `medium` by `combined-below-55` can tell the difference between a policy decision
 *     and a bug.
 *   - **The evidence crop, full size, with the honest placeholder** when there is none — which on
 *     this estate is every sighting.
 *
 * The crop is **refetched** when the row expands rather than reused from the list payload: D2-06
 * mints `cropUrl` per response, signed for 900 s, and a queue left open through a shift has dead
 * links. `cropUri` (`s3://…`) is the stable identifier and is shown beside it.
 */
import { useEffect, useState } from 'react';
import { traceHref } from '@/src/lib/trace/query';
import {
  CATEGORY_LABEL,
  cropState,
  formatClock,
  formatDate,
  formatDistance,
  distanceWasRounded,
  formatScore,
  traceWindow,
} from '@/src/lib/alerts/present';
import { reloadAlert } from './actions';
import type { AlertRecord } from './types';

export interface AlertDetailProps {
  alert: AlertRecord;
  /** `trace:run` — an auditor deliberately does not have it, and the link would dead-end at a 403. */
  mayTrace: boolean;
  onRefreshed: (alert: AlertRecord) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">{label}</dt>
      <dd className="mt-0.5 truncate text-xs text-slate-200">{children}</dd>
    </div>
  );
}

export function AlertDetail({ alert, mayTrace, onRefreshed }: AlertDetailProps) {
  const [cropFailed, setCropFailed] = useState(false);

  // Refetch on expand — the signed crop URL in the list payload may already be past its 900 s.
  useEffect(() => {
    let live = true;
    void reloadAlert(alert.id).then((fresh) => {
      if (live && fresh !== null) {
        setCropFailed(false);
        onRefreshed(fresh);
      }
    });
    return () => {
      live = false;
    };
    // Keyed on the id alone, deliberately: `onRefreshed` is a new closure on every parent render,
    // so including it would refetch the crop on every keystroke in the queue.
  }, [alert.id]);

  const { camera, sighting, evidence, watchlistRecord, identification, severityBasis } =
    alert.reason;
  const crop = cropState(evidence, cropFailed);
  const window = traceWindow(alert);

  return (
    <section
      data-testid="alert-detail"
      aria-label={`Evidence for the alert on ${identification.observedPlate}`}
      className="border-b border-slate-800 bg-slate-950/70 px-6 py-5"
    >
      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {/* ── the crop ──────────────────────────────────────────────────────────────────── */}
        <div>
          <h3 className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
            Evidence crop
          </h3>
          <div className="mt-2 flex min-h-40 items-center justify-center rounded-md border border-slate-800 bg-slate-950 p-2">
            {crop.kind === 'image' ? (
              <img
                src={crop.url}
                alt={`Full evidence crop from ${camera.name} at ${formatClock(sighting.ts)}`}
                className="max-h-64 w-auto"
                onError={() => {
                  setCropFailed(true);
                }}
              />
            ) : (
              <p
                data-testid="alert-detail-crop-placeholder"
                className="px-4 text-center text-xs leading-relaxed text-slate-500"
              >
                {crop.reason}
              </p>
            )}
          </div>
          <p className="mt-2 break-all text-[10px] text-slate-600">
            {evidence.cropUri ?? 'crop_uri is null on this sighting'}
          </p>
          <p className="text-[10px] text-slate-600">
            {evidence.isBestShot
              ? 'this sighting is the track’s best shot'
              : 'not the track’s best shot — a clearer crop may exist'}
          </p>
        </div>

        {/* ── the payload ──────────────────────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-5">
          {/* Caveats first. They are the thing most likely to change an officer's mind. */}
          <div>
            <h3 className="text-[10px] font-semibold tracking-wide text-amber-400 uppercase">
              Read this before acting
            </h3>
            <ul data-testid="alert-caveats" className="mt-2 space-y-1.5">
              {alert.reason.caveats.map((caveat) => (
                <li key={caveat} className="flex gap-2 text-xs leading-relaxed text-amber-100/90">
                  <span aria-hidden="true" className="text-amber-500">
                    ▸
                  </span>
                  <span>{caveat}</span>
                </li>
              ))}
            </ul>
          </div>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
            <Field label="Read (raw)">
              <span className="font-mono">{identification.observedPlate}</span>
            </Field>
            <Field label="Read (corrected)">
              <span className="font-mono">{identification.correctedPlate}</span>
            </Field>
            <Field label="Watchlist value">
              <span className="font-mono">{identification.watchlistValue}</span>
            </Field>
            <Field label="Validity">
              {identification.validity}
              {identification.rejectionCodes.length === 0
                ? ''
                : ` · ${identification.rejectionCodes.join(', ')}`}
            </Field>

            <Field label="OCR confidence">{formatScore(identification.plateConfidence)}</Field>
            <Field label="OCR after grammar">
              {formatScore(identification.adjustedPlateConfidence)}
            </Field>
            <Field label="Match strength">{formatScore(identification.matchConfidence)}</Field>
            <Field label="Combined (product)">
              {formatScore(identification.combinedConfidence)}
            </Field>

            <Field label="Weighted distance">
              {formatDistance(alert.matchDistance)}
              {distanceWasRounded(alert.matchDistance) ? (
                <span className="text-slate-500"> (rounded from {alert.matchDistance})</span>
              ) : null}
            </Field>
            <Field label="Completeness">{formatScore(identification.completeness)}</Field>
            <Field label="Missing characters">
              {identification.missingChars === null
                ? 'no layout matched'
                : String(identification.missingChars)}
            </Field>
            <Field label="Policy version">v{alert.reason.policyVersion}</Field>
          </dl>

          {/* ── severity derivation ─────────────────────────────────────────────────────── */}
          <div>
            <h3 className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
              How this severity was reached
            </h3>
            <p data-testid="alert-severity-basis" className="mt-1 text-xs text-slate-300">
              category <span className="text-slate-100">{severityBasis.fromCategory}</span> · entry{' '}
              <span className="text-slate-100">{severityBasis.fromEntry}</span> → final{' '}
              <span className="font-semibold text-slate-100">{severityBasis.final}</span>
              {severityBasis.ceilingsApplied.length === 0
                ? ' · no ceiling applied'
                : ` · lowered by ${severityBasis.ceilingsApplied.join(', ')}`}
              {' · category rank '}
              {severityBasis.categoryRank}
            </p>
          </div>

          {/* ── the matched record, with its provenance ─────────────────────────────────── */}
          <div>
            <h3 className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
              Matched watchlist record
            </h3>
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
              <Field label="Category">{CATEGORY_LABEL[watchlistRecord.category]}</Field>
              <Field label="Entry severity">{watchlistRecord.entrySeverity}</Field>
              <Field label="Source system">
                {watchlistRecord.sourceSystem}
                {watchlistRecord.sourceRef === null ? '' : ` · ${watchlistRecord.sourceRef}`}
              </Field>
              <Field label="Provider answered">
                <span data-testid="alert-live-flag" className="font-semibold text-amber-300">
                  {watchlistRecord.providerSystem} (mock · live={String(watchlistRecord.live)})
                </span>
              </Field>
              <Field label="Valid from">{formatDate(watchlistRecord.validFrom)}</Field>
              <Field label="Valid to">
                {watchlistRecord.validTo === null ? 'open' : formatDate(watchlistRecord.validTo)}
              </Field>
              <Field label="Entity">{watchlistRecord.entityType}</Field>
              <Field label="Plate on record">
                <span className="font-mono">{watchlistRecord.plateNormalized ?? '—'}</span>
              </Field>
            </dl>
            {watchlistRecord.note === null ? null : (
              <p
                data-testid="alert-watchlist-note"
                className="mt-3 rounded-md border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-[11px] leading-relaxed text-amber-100/90"
              >
                <span className="font-semibold">Record provenance: </span>
                {watchlistRecord.note}
              </p>
            )}
          </div>

          {/* ── camera and sighting ─────────────────────────────────────────────────────── */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
            <Field label="Camera">
              {camera.name} ({camera.externalId})
            </Field>
            <Field label="Location">
              {camera.location === null
                ? 'no location on file'
                : `${camera.location.lat.toFixed(5)}, ${camera.location.lon.toFixed(5)}`}
            </Field>
            <Field label="Camera trust">
              {camera.trustScore === null ? 'never probed' : Math.round(camera.trustScore)}
            </Field>
            <Field label="District">{camera.district ?? '—'}</Field>
            <Field label="Sighting time (PTS)">
              {formatClock(sighting.ts)} · pts {sighting.framePtsMs} ms
            </Field>
            <Field label="Track id">{sighting.trackId}</Field>
            <Field label="Class">{sighting.vehicleClass}</Field>
            <Field label="Dedupe key">
              <span className="font-mono text-[10px]">{alert.dedupeKey}</span>
            </Field>
          </dl>

          {/* ── actions out of the row ──────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {mayTrace ? (
              <a
                data-testid="alert-trace-link"
                href={traceHref({
                  plate: identification.observedPlate,
                  from: window.from,
                  to: window.to,
                })}
                className="rounded-md border border-sky-800 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-950/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              >
                Trace this vehicle →
              </a>
            ) : (
              <span className="text-[11px] text-slate-500">
                Vehicle tracing needs the <code>trace:run</code> capability, which this role does
                not have.
              </span>
            )}
            <a
              href={`/registry?selected=${camera.id}`}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            >
              Camera detail →
            </a>
            <p className="text-[11px] text-slate-500">
              Alert <span className="font-mono">{alert.id}</span>
            </p>
          </div>

          <p
            data-testid="alert-disclaimer"
            className="rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-[11px] leading-relaxed text-slate-400"
          >
            {alert.reason.disclaimer}
          </p>
        </div>
      </div>
    </section>
  );
}
