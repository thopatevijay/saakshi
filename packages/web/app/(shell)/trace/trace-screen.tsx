'use client';

/**
 * The vehicle trace screen (D2-08) — the graded live test case.
 *
 * A jury hands over a registration and expects the vehicle's route. What this screen must never do
 * is make that route look more certain than it is. Three things enforce that, and they are the
 * reason the layout is shaped the way it is:
 *
 *  1. **A claims banner above the result, not a footnote below it.** What is observed and what is
 *     inferred, in the API's own words, before the reader looks at a single pin.
 *  2. **Link method on every artefact.** The map pin, the timeline tick, the evidence tile and the
 *     table row all carry the same colour and the same confidence. A fuzzy link is amber wherever
 *     it appears; an exact one is sky. On this estate almost every link is fuzzy, and that has to
 *     be the first thing a reader notices rather than something they discover.
 *  3. **The coverage line states the gaps.** How many sightings can be mapped, how many carry a
 *     crop, how many candidates the confidence floor removed. A trace that silently drops half its
 *     evidence looks better and is worse.
 *
 * State lives in the URL (`src/lib/trace/query.ts`) and is rewritten with `history.replaceState`
 * rather than `router.push`, for D1-08's reason: selecting a pin must not re-run a server component
 * and remount the WebGL context.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import dynamic from 'next/dynamic';
import { EmptyState, LoadingPanel } from '@/src/components/states';
import { LINK_STYLE, type TraceablePoint } from '@/src/lib/trace/geojson';
import {
  parseTraceQuery,
  purposeIsStated,
  toSearchParams,
  type TraceQueryState,
} from '@/src/lib/trace/query';
import { runTrace } from './actions';
import { EvidenceStrip } from './evidence-strip';
import { QueryConsole } from './query-console';
import { RouteSummary } from './route-summary';
import { TraceTimeline, formatDuration } from './trace-timeline';
import type { TracePayload, TraceSighting } from './types';

/** `ssr: false` because MapLibre needs a DOM and a WebGL context, neither of which Node has. */
const TraceMap = dynamic(() => import('./trace-map').then((m) => m.TraceMap), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[26rem] items-center justify-center rounded-lg border border-slate-800 bg-[#0b1220]">
      <LoadingPanel rows={0} label="Loading map" />
    </div>
  ),
});

const BUTTON =
  'rounded-md border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-sky-800 hover:text-sky-200 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400';
const FIELD =
  'rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-400';

export interface TraceScreenProps {
  initialQuery: TraceQueryState;
  initialTrace: TracePayload | null;
  initialError: string | null;
  initialElapsedMs: number;
}

export function TraceScreen({
  initialQuery,
  initialTrace,
  initialError,
  initialElapsedMs,
}: TraceScreenProps) {
  const [query, setQuery] = useState<TraceQueryState>(initialQuery);
  const [draft, setDraft] = useState(initialQuery);
  const [trace, setTrace] = useState<TracePayload | null>(initialTrace);
  const [error, setError] = useState<string | null>(initialError);
  const [elapsedMs, setElapsedMs] = useState(initialElapsedMs);
  const [pending, startTransition] = useTransition();
  const first = useRef(true);

  const sightings: TraceSighting[] = useMemo(() => trace?.sightings ?? [], [trace]);
  const points: TraceablePoint[] = sightings;

  // The URL is the screen. `replaceState` so a pin click never re-runs the server component.
  useEffect(() => {
    const params = toSearchParams(query).toString();
    window.history.replaceState(null, '', params === '' ? '/trace' : `/trace?${params}`);
  }, [query]);

  // Re-run only when the *query* changes — not when the selection moves.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    startTransition(async () => {
      const next = await runTrace(query);
      setTrace(next.trace);
      setError(next.error);
      setElapsedMs(next.elapsedMs);
    });
    // Deliberately keyed on the query's fields rather than on `query` itself: `query.seq` changes
    // on every pin click, and re-tracing on a selection change would refetch the same route.
    // `purpose` is in the list because a trace run under a different stated reason is a different
    // audited event, not a cached result (D3-04).
  }, [
    query.plate,
    query.purpose,
    query.caseRef,
    query.from,
    query.to,
    query.minConfidence,
    query.maxDistance,
    // D3-03: turning appearance links on or off is a different evidentiary standard, so it is a
    // different trace and a different audited event — never a client-side filter over a cached one.
    query.includeReid,
  ]);

  const select = useCallback((seq: number | null) => {
    setQuery((current) => ({ ...current, seq }));
  }, []);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      setQuery({ ...draft, seq: null });
    },
    [draft],
  );

  const exportHref = (format: 'csv' | 'pdf'): string => {
    const params = toSearchParams({ ...query, seq: null });
    params.set('format', format);
    return `/trace/export?${params.toString()}`;
  };

  const coverage = trace?.coverage ?? null;
  const hasResult = trace !== null && query.plate !== '';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">Vehicle trace</h1>
        {hasResult ? (
          <p className="text-xs text-slate-500 tabular-nums">
            {elapsedMs} ms round trip · {trace.tookMs} ms in the API · matcher {trace.matcher}
          </p>
        ) : null}
      </div>

      {/*
        D3-09's plain-English box sits above the deterministic filter, not instead of it. With
        `QUERY_COMPILER=none` it explains itself and steps aside, and what is left is the filter
        that was always the primary interface — which is exactly the graceful degradation the
        ticket asks for, reached by placement rather than by a fallback path.
      */}
      <QueryConsole purpose={draft.purpose} caseRef={draft.caseRef} />

      {/* ── the query ─────────────────────────────────────────────────────────────────────── */}
      <form onSubmit={submit} role="search" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            Registration
          </span>
          <input
            name="plate"
            value={draft.plate}
            onChange={(e) => {
              setDraft({ ...draft, plate: e.target.value.replace(/\s+/g, '').toUpperCase() });
            }}
            placeholder="GJ01AB1234"
            autoComplete="off"
            spellCheck={false}
            data-testid="trace-plate"
            className={`${FIELD} w-48 font-mono tracking-wide`}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            Purpose <span className="text-amber-300/80">required</span>
          </span>
          <input
            name="purpose"
            value={draft.purpose}
            onChange={(e) => {
              setDraft({ ...draft, purpose: e.target.value.slice(0, 500) });
            }}
            placeholder="why this vehicle is being traced"
            autoComplete="off"
            data-testid="trace-purpose"
            className={`${FIELD} w-72`}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            Case / FIR
          </span>
          <input
            name="case_ref"
            value={draft.caseRef ?? ''}
            onChange={(e) => {
              setDraft({ ...draft, caseRef: e.target.value.trim() === '' ? null : e.target.value });
            }}
            placeholder="FIR/2026/00123"
            autoComplete="off"
            spellCheck={false}
            data-testid="trace-case-ref"
            className={`${FIELD} w-48 font-mono`}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            From
          </span>
          <input
            type="datetime-local"
            value={toLocalInput(draft.from)}
            onChange={(e) => {
              setDraft({ ...draft, from: fromLocalInput(e.target.value) });
            }}
            className={`${FIELD} w-56`}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            To
          </span>
          <input
            type="datetime-local"
            value={toLocalInput(draft.to)}
            onChange={(e) => {
              setDraft({ ...draft, to: fromLocalInput(e.target.value) });
            }}
            className={`${FIELD} w-56`}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            Min confidence {draft.minConfidence.toFixed(2)}
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={draft.minConfidence}
            data-testid="trace-min-confidence"
            onChange={(e) => {
              setDraft({ ...draft, minConfidence: Number(e.target.value) });
            }}
            className="h-9 w-40 accent-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            Appearance links
          </span>
          <span className="flex h-9 items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={draft.includeReid}
              data-testid="trace-include-reid"
              onChange={(e) => {
                setDraft({ ...draft, includeReid: e.target.checked });
              }}
              className="h-4 w-4 accent-violet-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
            />
            {/* Violet, matching the map's re-ID pins and the legend D2-08 shipped: the weakest
                claim in the system gets its own colour everywhere it appears. */}
            <span title="Vehicle appearance re-ID. Measured at 0.761 precision — roughly one link in four is wrong. Not face recognition: no biometrics are processed.">
              include re-ID
            </span>
          </span>
        </label>

        <button
          type="submit"
          className={`${BUTTON} h-9`}
          data-action="trace"
          disabled={pending || !purposeIsStated(draft)}
        >
          {pending ? 'Tracing…' : 'Trace'}
        </button>

        {hasResult && sightings.length > 0 ? (
          <>
            <a
              href={exportHref('csv')}
              download
              className={`${BUTTON} h-9 leading-6`}
              data-action="export-csv"
            >
              Export CSV
            </a>
            <a
              href={exportHref('pdf')}
              download
              className={`${BUTTON} h-9 leading-6`}
              data-action="export-pdf"
            >
              Export PDF
            </a>
          </>
        ) : null}
      </form>

      {error !== null ? (
        <p
          role="alert"
          className="rounded-md border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-200"
        >
          {error}
        </p>
      ) : null}

      {/* Purpose binding (D3-04). A registration alone does not start a search: arriving here from
          an alert's "trace this vehicle" link leaves the field waiting, deliberately, because a
          link can carry a vehicle but only a person can state a reason. */}
      {query.plate !== '' && !purposeIsStated(query) ? (
        <section
          className="rounded-lg border border-amber-900/60 bg-amber-950/20 px-4 py-3 text-sm text-amber-100"
          data-testid="trace-purpose-required"
        >
          <p className="font-semibold">State a purpose before searching {query.plate}.</p>
          <p className="mt-1 text-amber-200/80">
            Every trace is written into the tamper-evident audit chain against your badge, with the
            reason you give here and the case reference if you supply one. Nothing has been searched
            yet.
          </p>
        </section>
      ) : null}

      {/* ── what this screen is claiming ──────────────────────────────────────────────────── */}
      {hasResult ? (
        <section
          className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm"
          data-testid="trace-claims"
        >
          <p className="text-slate-300">
            <span className="font-semibold text-sky-300">Observed</span> — {trace.claims.observed}
          </p>
          <p className="mt-1.5 text-slate-300">
            <span className="font-semibold text-amber-300">Inferred</span> — {trace.claims.inferred}
          </p>
          {coverage === null ? null : (
            <p className="mt-2 text-xs text-slate-400 tabular-nums" data-testid="trace-coverage">
              {coverage.sightings} sighting{coverage.sightings === 1 ? '' : 's'} ·{' '}
              {coverage.exactLinks} exact / {coverage.fuzzyLinks} fuzzy
              {coverage.otherLinks > 0 ? ` / ${coverage.otherLinks} appearance` : ''} ·{' '}
              {coverage.sightingsMappable} of {coverage.sightings} mappable (
              {coverage.camerasPlaced} of {coverage.cameras} camera
              {coverage.cameras === 1 ? '' : 's'} placed) · {coverage.sightingsWithCrop} with a crop
              {coverage.droppedBelowConfidence > 0
                ? ` · ${coverage.droppedBelowConfidence} below the confidence floor`
                : ''}
              {coverage.truncated ? ' · truncated at the row cap' : ''}
            </p>
          )}
          {/* D3-03. Rendered whenever appearance links were asked for or found — never silently.
              A screen that shows a re-ID link without its measured precision is over-claiming, and
              a switch that looks on while the server has the feature off is worse. */}
          {trace.reid !== undefined && (trace.reid.requested || trace.reid.links > 0) ? (
            <p
              className="mt-2 rounded border border-violet-900/60 bg-violet-950/30 px-2.5 py-1.5 text-xs text-violet-200"
              data-testid="trace-reid-note"
            >
              {trace.reid.requested && !trace.reid.enabled ? (
                <>
                  <span className="font-semibold">Appearance links unavailable.</span> They were
                  asked for, but re-ID is disabled on this deployment. Everything above is a plate
                  read.
                </>
              ) : (
                <>
                  <span className="font-semibold">
                    {trace.reid.links} link{trace.reid.links === 1 ? '' : 's'} by vehicle appearance
                  </span>{' '}
                  — measured at {(trace.reid.measuredPrecision * 100).toFixed(1)}% precision, so
                  roughly one in{' '}
                  {Math.max(2, Math.round(1 / Math.max(1e-6, 1 - trace.reid.measuredPrecision)))} is
                  wrong. Not face recognition; no biometrics are processed. Untick{' '}
                  <span className="font-semibold">include re-ID</span> for a plate-only trace.
                </>
              )}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ── the result ────────────────────────────────────────────────────────────────────── */}
      {!hasResult ? (
        <EmptyState
          title="Enter a registration"
          description="A trace returns every sighting linked to that registration, in order, with the confidence and the method behind each link. Alerts link here directly."
        />
      ) : sightings.length === 0 ? (
        <EmptyState title="No sightings" description={emptyDescription(trace)} />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="min-h-[26rem]">
              {coverage !== null && coverage.sightingsMappable === 0 ? (
                <div
                  className="flex h-full min-h-[26rem] items-center justify-center rounded-lg border border-dashed border-slate-700 bg-slate-900/40 px-6 text-center"
                  data-testid="trace-map-unavailable"
                >
                  <p className="max-w-md text-sm text-slate-400">
                    None of the {coverage.cameras} camera
                    {coverage.cameras === 1 ? '' : 's'} in this trace has coordinates, so there is
                    nothing to place on a map. The Sentinel catalogue publishes an id and a name
                    only. The route is still complete below — it is a timeline rather than a map.
                  </p>
                </div>
              ) : (
                <TraceMap
                  sightings={points}
                  route={trace.route?.segments ?? []}
                  selectedSeq={query.seq}
                  onSelect={select}
                />
              )}
            </div>

            <div className="space-y-4">
              {trace.route === null ? null : <RouteSummary route={trace.route} onSelect={select} />}
              <TraceTimeline sightings={points} selectedSeq={query.seq} onSelect={select} />
              <LinkLegend />
            </div>
          </div>

          <EvidenceStrip
            sightings={sightings}
            selectedSeq={query.seq}
            onSelect={select}
            plate={trace.normalized}
          />

          <SightingTable trace={trace} selectedSeq={query.seq} onSelect={select} />
        </>
      )}
    </div>
  );
}

function LinkLegend() {
  return (
    <section
      className="rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3"
      data-testid="trace-legend"
    >
      <h2 className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
        How each sighting was linked
      </h2>
      <ul className="mt-2 space-y-1.5">
        {(['plate_exact', 'plate_fuzzy', 'reid_bridge'] as const).map((method) => (
          <li key={method} className="flex items-start gap-2 text-xs" data-link-method={method}>
            <span
              aria-hidden="true"
              className="mt-1 size-2.5 shrink-0 rounded-full border"
              style={{
                backgroundColor: LINK_STYLE[method].fill,
                borderColor: LINK_STYLE[method].stroke,
              }}
            />
            <span>
              <span className="font-medium text-slate-200">{LINK_STYLE[method].label}</span>{' '}
              <span className="text-slate-400">{LINK_STYLE[method].note}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SightingTable({
  trace,
  selectedSeq,
  onSelect,
}: {
  trace: TracePayload;
  selectedSeq: number | null;
  onSelect: (seq: number | null) => void;
}) {
  const segmentTo = new Map(trace.segments.map((s) => [s.toSeq, s]));
  // D3-01. The hover tooltip on the map is not the only place the distinction may live: a
  // keyboard reader and a printed case file both need it, so the table carries it too.
  const routeTo = new Map((trace.route?.segments ?? []).map((s) => [s.toSeq, s]));
  return (
    <section
      className="overflow-x-auto rounded-lg border border-slate-800"
      data-testid="trace-table"
    >
      <table className="w-full min-w-[64rem] text-left text-xs">
        <caption className="sr-only">
          Sightings linked to {trace.normalized}, in chronological order, with the gap inferred
          between each pair.
        </caption>
        <thead className="bg-slate-900/60 text-[11px] tracking-wide text-slate-400 uppercase">
          <tr>
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">Timestamp (from PTS)</th>
            <th className="px-3 py-2">Camera</th>
            <th className="px-3 py-2">Session / track</th>
            <th className="px-3 py-2">Read</th>
            <th className="px-3 py-2">Link</th>
            <th className="px-3 py-2">Conf.</th>
            <th className="px-3 py-2">Gap from previous (inferred)</th>
            <th className="px-3 py-2">Road-graph segment</th>
          </tr>
        </thead>
        <tbody>
          {trace.sightings.map((s) => {
            const segment = segmentTo.get(s.seq);
            const hop = routeTo.get(s.seq);
            const style = LINK_STYLE[s.linkMethod];
            return (
              <tr
                key={s.sightingId}
                data-row={s.seq}
                onClick={() => {
                  onSelect(s.seq === selectedSeq ? null : s.seq);
                }}
                className={`cursor-pointer border-t border-slate-800 ${
                  s.seq === selectedSeq ? 'bg-sky-950/30' : 'hover:bg-slate-900/40'
                }`}
              >
                <td className="px-3 py-2 font-semibold text-slate-200 tabular-nums">{s.seq}</td>
                <td className="px-3 py-2 text-slate-300 tabular-nums">
                  {s.ts.replace('T', ' ').replace('Z', '').slice(0, 23)}
                </td>
                <td className="px-3 py-2 text-slate-300">
                  {s.cameraName} <span className="text-slate-500">({s.cameraExternalId})</span>
                  {s.located ? null : <span className="ml-1 text-slate-600">· not placed</span>}
                </td>
                <td className="px-3 py-2 text-slate-400 tabular-nums">
                  {s.trackingSession} / {s.rawTrackerId}
                </td>
                <td className="px-3 py-2 font-mono text-slate-300">{s.plateRawText}</td>
                <td className="px-3 py-2">
                  <span
                    className="inline-block rounded border px-2 py-0.5 text-[11px] font-medium"
                    style={{ borderColor: style.stroke, color: style.fill }}
                    title={s.explanation}
                  >
                    {style.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-200 tabular-nums">
                  {s.linkConfidence.toFixed(2)}
                </td>
                <td className="px-3 py-2 text-slate-400 tabular-nums">
                  {segment === undefined ? (
                    <span className="text-slate-600">—</span>
                  ) : (
                    <>
                      {formatDuration(segment.gapSeconds)}
                      {segment.straightLineKm === null
                        ? ' · no distance (camera not placed)'
                        : segment.sameCamera
                          ? ' · same camera'
                          : ` · ≥ ${segment.straightLineKm.toFixed(2)} km, ≤ ${String(segment.impliedSpeedKmh ?? 0)} km/h`}
                    </>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-400 tabular-nums" data-route-cell={s.seq}>
                  {hop === undefined ? (
                    <span className="text-slate-600">—</span>
                  ) : (
                    <>
                      <span
                        className="mr-1.5 inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
                        data-route-basis={hop.basis}
                        style={{
                          borderColor: hop.observed ? '#34d399' : '#f59e0b',
                          color: hop.observed ? '#6ee7b7' : '#fcd34d',
                        }}
                      >
                        {hop.observed ? 'Observed' : 'Inferred'}
                      </span>
                      {hop.roadDistanceKm === null
                        ? 'no path'
                        : `${hop.roadDistanceKm.toFixed(2)} km`}
                      {hop.inferredConfidence === null
                        ? ''
                        : ` · conf ${hop.inferredConfidence.toFixed(2)}`}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-slate-800 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-500">
        {trace.disclaimer}
      </p>
    </section>
  );
}

function emptyDescription(trace: TracePayload): string {
  switch (trace.emptyReason) {
    case 'query_not_searchable':
      return `“${trace.query}” cannot be read as an Indian registration, so it was not searched against the estate. Fuzzing a phone number or a hoarding against every plate in the corpus is refused deliberately.`;
    case 'no_matching_plate':
      return `No plate read is within the matcher's distance limit of ${trace.normalized}. Widening max_distance finds more, at a measured cost to precision.`;
    case 'below_min_confidence':
      return `Candidates were found, but every one fell below the confidence floor of ${trace.minConfidence.toFixed(2)}. Lower it to see them, flagged as the weak links they are.`;
    default:
      return `No sightings of ${trace.normalized} in this window.`;
  }
}

/** `datetime-local` speaks the browser's local time; the URL and the API speak UTC. */
function toLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export { parseTraceQuery };
