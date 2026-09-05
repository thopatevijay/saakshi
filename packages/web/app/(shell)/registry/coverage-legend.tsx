'use client';

/**
 * The coverage legend and its on/off switch (D3-06).
 *
 * Separate from the trust-band legend because it answers a different question. The band legend
 * says *"what is this camera like?"*; this one says *"what does this patch of road actually have?"*
 * — and the whole point of the overlay is that those two answers come apart.
 *
 * Three things this component is careful about:
 *
 * - **The counts are cells, not kilometres.** A cell is one camera's disc; two overlapping discs
 *   cover less road than the sum of their areas. The heading says "cells" and the report carries
 *   the kilometres, so nobody reads a cell count as a coverage figure.
 * - **`uncovered` has a swatch with no fill**, because it has no geometry — it is bare basemap.
 *   Giving it a solid colour would imply a layer that does not exist.
 * - **The caption changes with the data.** When every cell is untrusted — which is the state the
 *   measured estate is in — that is the finding, and a static caption would let a reader assume
 *   the overlay had failed to load.
 */
import {
  COVERAGE_STATES,
  COVERAGE_STYLE,
  coverageCaption,
  countByState,
  type CoverageFeatureCollection,
} from '@/src/lib/registry/coverage';

export function CoverageLegend({
  data,
  enabled,
  onToggle,
  loading,
}: {
  data: CoverageFeatureCollection;
  enabled: boolean;
  onToggle: () => void;
  loading: boolean;
}) {
  const counts = countByState(data);

  return (
    <section aria-labelledby="coverage-heading" className="space-y-2" data-testid="coverage-legend">
      <div className="flex items-baseline justify-between">
        <h3
          id="coverage-heading"
          className="text-xs font-semibold uppercase tracking-wide text-slate-400"
        >
          Coverage cells
        </h3>
        <button
          type="button"
          aria-pressed={enabled}
          data-testid="coverage-toggle"
          onClick={onToggle}
          className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
            enabled
              ? 'border-sky-800 bg-sky-950/50 text-sky-300'
              : 'border-slate-800 bg-slate-900/30 text-slate-600'
          }`}
        >
          {enabled ? 'on' : 'off'}
        </button>
      </div>

      <ul className="space-y-1">
        {COVERAGE_STATES.map((state) => {
          const style = COVERAGE_STYLE[state];
          return (
            <li key={state} data-coverage-state={state} className="flex gap-2 px-1 py-1 text-left">
              <span
                aria-hidden
                className="mt-1 size-3 shrink-0 rounded-sm border"
                style={{
                  backgroundColor: style.fill ?? 'transparent',
                  borderColor: style.outline,
                  opacity: style.fill === null ? 1 : 0.85,
                }}
              />
              <span className="min-w-0">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-[11px] font-medium text-slate-300">{style.label}</span>
                  {state === 'uncovered' ? (
                    <span className="text-[11px] text-slate-600">no layer</span>
                  ) : (
                    <span className="text-[11px] tabular-nums text-slate-500">{counts[state]}</span>
                  )}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                  {style.meaning}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      <p className="text-[11px] leading-snug text-slate-500" data-testid="coverage-caption">
        {loading ? 'Loading coverage cells…' : coverageCaption(data)}
      </p>
      <p className="text-[11px] leading-snug text-slate-600">
        Counts are cells, one per placed camera — not kilometres. Overlapping cells cover less road
        than their areas add up to; the road-kilometre figures are in{' '}
        <code className="text-slate-500">docs/gap-analysis-sample.md</code>.
      </p>
    </section>
  );
}
