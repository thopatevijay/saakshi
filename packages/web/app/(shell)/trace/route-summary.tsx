'use client';

/**
 * The route summary, the legend, and the tray of what could not be drawn (D3-01).
 *
 * This component carries the acceptance criterion that a reviewer who has never seen the app can
 * tell which parts of the answer are evidence and which are inference. Three things do that, and
 * none of them is a colour:
 *
 *  1. **The headline split is a sentence, not a chart.** "0.0 km observed · 18.4 km inferred" is
 *     the most important fact about a reconstructed route on this estate, and it is stated in the
 *     largest text on the panel rather than encoded in a legend a reader has to decode.
 *  2. **The legend shows the actual line.** An inline SVG of the real stroke — solid and thick, or
 *     dashed and thin — beside the sentence that says what it means, so the mapping from the map to
 *     the meaning needs no memory.
 *  3. **A "Not drawn" tray.** Segments with no geometry are listed with the reason, because a
 *     segment that vanishes from the map without explanation reads as a route that had no gap.
 *     D1-08 established this pattern for unplaced cameras; it is the same problem.
 */
import { ROUTE_LINE_STYLE, SEGMENT_KIND_LABEL, formatSeconds } from '@/src/lib/trace/route-geojson';
import type { TracePayload } from './types';

type Route = NonNullable<TracePayload['route']>;

export function RouteSummary({
  route,
  onSelect,
}: {
  route: Route;
  onSelect: (seq: number | null) => void;
}) {
  const s = route.summary;
  const undrawable = route.segments.filter(
    (segment) => segment.geometry === null || segment.geometry.coordinates.length < 2,
  );

  return (
    <section
      className="rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3"
      data-testid="route-summary"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
          Reconstructed route
        </h2>
        <p className="text-[11px] text-slate-500 tabular-nums">
          {route.cache.hit ? 'from cache' : `built in ${String(route.buildMs)} ms`} ·{' '}
          {route.roadGraph.available ? 'road graph live' : 'no road graph'} · model{' '}
          {route.roadGraph.modelVersion}
        </p>
      </div>

      {/* 1 · the split, stated. */}
      <p className="mt-2 text-sm text-slate-200 tabular-nums" data-testid="route-split">
        <span className="font-semibold text-emerald-300">
          {s.observedKm.toFixed(1)} km observed
        </span>
        <span className="text-slate-500"> · </span>
        <span className="font-semibold text-amber-300">{s.inferredKm.toFixed(1)} km inferred</span>
      </p>
      <p className="mt-1 text-xs text-slate-400 tabular-nums">
        {s.segments} segment{s.segments === 1 ? '' : 's'} ({s.observedSegments} observed,{' '}
        {s.inferredSegments} inferred) · {s.cameras} camera{s.cameras === 1 ? '' : 's'} (
        {s.camerasPlaced} placed) · {formatSeconds(s.elapsedSeconds)} elapsed
        {s.meanInferredConfidence === null
          ? ''
          : ` · mean inferred confidence ${s.meanInferredConfidence.toFixed(2)}`}
      </p>
      {s.unmeasuredSegments > 0 ? (
        <p className="mt-1 text-xs text-slate-500">
          {s.totalKm.toFixed(1)} km is a lower bound: {s.unmeasuredSegments} of {s.segments} segment
          {s.segments === 1 ? '' : 's'} could not be measured at all, and a road-graph distance is
          the shortest path rather than the path driven.
        </p>
      ) : null}

      {/* 2 · the legend, showing the actual stroke. */}
      <ul className="mt-3 space-y-2" data-testid="route-legend">
        <LegendRow kind="observed" text={route.legend.observed} />
        <LegendRow kind="inferred" text={route.legend.inferred} />
      </ul>

      {/* 3 · what is not on the map, and why. */}
      {undrawable.length > 0 ? (
        <details className="mt-3" data-testid="route-undrawn">
          <summary className="cursor-pointer text-xs font-medium text-slate-300">
            Not drawn · {undrawable.length}
          </summary>
          <ul className="mt-2 space-y-1.5">
            {undrawable.map((segment) => (
              <li key={segment.seq} className="text-xs">
                <button
                  type="button"
                  onClick={() => {
                    onSelect(segment.fromSeq);
                  }}
                  className="text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                >
                  <span className="font-medium text-slate-200 tabular-nums">
                    {segment.fromSeq} → {segment.toSeq}
                  </span>{' '}
                  <span className="text-slate-400">
                    {SEGMENT_KIND_LABEL[segment.kind]} — {segment.note}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function LegendRow({ kind, text }: { kind: 'observed' | 'inferred'; text: string }) {
  const style = ROUTE_LINE_STYLE[kind];
  return (
    <li className="flex items-start gap-2.5 text-xs" data-route-legend={kind}>
      <svg width="34" height="14" aria-hidden="true" className="mt-0.5 shrink-0">
        <line
          x1="1"
          y1="7"
          x2="33"
          y2="7"
          stroke={style.colour}
          strokeWidth={style.width}
          strokeOpacity={style.opacity}
          strokeLinecap="round"
          {...(style.dash === null
            ? {}
            : { strokeDasharray: style.dash.map((n) => n * 3).join(' ') })}
        />
      </svg>
      <span>
        <span
          className="font-semibold"
          style={{ color: kind === 'observed' ? '#6ee7b7' : '#fcd34d' }}
        >
          {style.label}
        </span>{' '}
        <span className="text-slate-400">{text}</span>
      </span>
    </li>
  );
}
