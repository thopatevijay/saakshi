'use client';

/**
 * The timeline scrubber (D2-08).
 *
 * **Synchronised to the map in both directions.** Dragging the handle selects the sighting that was
 * in effect at that instant and the map eases to it; clicking a pin moves the handle to where
 * scrubbing to that sighting would have put it. Both directions go through the same two pure
 * functions in `src/lib/trace/geojson.ts`, which is where the behaviour is tested — `seqAtFraction`
 * and `fractionOfSeq` are asserted to round-trip.
 *
 * **It scrubs time, not index.** The sightings are unevenly spaced: the estate delivers about four
 * effective frames a second and a vehicle sits in one camera's view for many of them, so an
 * evenly-stepped index would move the handle in lurches that do not correspond to the journey. The
 * tick marks are therefore positioned by *when* each sighting happened, and the gaps between them
 * are the gaps in the evidence — visible, which is the point.
 *
 * A native `<input type="range">` carries the keyboard interaction, the ARIA semantics and the
 * focus ring for free; the ticks are painted behind it.
 */
import { useId } from 'react';
import {
  LINK_STYLE,
  elapsedSeconds,
  fractionOfSeq,
  seqAtFraction,
  type TraceablePoint,
} from '@/src/lib/trace/geojson';

/** Range inputs work in integers; 1000 steps over the window is finer than a pixel. */
const STEPS = 1000;

export interface TraceTimelineProps {
  sightings: readonly TraceablePoint[];
  selectedSeq: number | null;
  onSelect: (seq: number | null) => void;
}

export function TraceTimeline({ sightings, selectedSeq, onSelect }: TraceTimelineProps) {
  const labelId = useId();
  if (sightings.length === 0) return null;

  const first = sightings[0];
  const last = sightings.at(-1);
  const spanS = last === undefined || first === undefined ? 0 : elapsedSeconds(sightings, last.seq);
  const value = Math.round(fractionOfSeq(sightings, selectedSeq) * STEPS);
  const selected = sightings.find((s) => s.seq === selectedSeq) ?? null;

  return (
    <section
      className="rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-4"
      data-testid="trace-timeline"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id={labelId}
          className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase"
        >
          Timeline
        </h2>
        <p className="text-xs text-slate-400 tabular-nums">
          {sightings.length} sighting{sightings.length === 1 ? '' : 's'} over{' '}
          {formatDuration(spanS)}
        </p>
      </div>

      <div className="relative mt-4">
        {/* Ticks sit at their real position in time, so the gaps in the evidence are visible. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1 h-3">
          {sightings.map((s) => (
            <span
              key={s.sightingId}
              className="absolute top-0 h-3 w-0.5 -translate-x-1/2 rounded"
              style={{
                left: `${String(fractionOfSeq(sightings, s.seq) * 100)}%`,
                backgroundColor: LINK_STYLE[s.linkMethod].fill,
                opacity: s.seq === selectedSeq ? 1 : 0.55,
              }}
            />
          ))}
        </div>

        <input
          type="range"
          min={0}
          max={STEPS}
          step={1}
          value={value}
          aria-labelledby={labelId}
          aria-valuetext={
            selected === null
              ? 'no sighting selected'
              : `sighting ${String(selected.seq)} of ${String(sightings.length)}, ${selected.cameraName}, ${selected.ts}`
          }
          data-testid="trace-scrubber"
          onChange={(event) => {
            onSelect(seqAtFraction(sightings, Number(event.target.value) / STEPS));
          }}
          className="mt-4 w-full accent-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        />
      </div>

      <div className="mt-1 flex justify-between text-[11px] text-slate-500 tabular-nums">
        <span>{formatTime(first?.ts)}</span>
        <span>{formatTime(last?.ts)}</span>
      </div>

      <p
        className="mt-3 min-h-[2.5rem] text-sm text-slate-300"
        aria-live="polite"
        data-testid="trace-timeline-readout"
      >
        {selected === null ? (
          <span className="text-slate-500">
            Drag the handle, or select a pin, to step through the route.
          </span>
        ) : (
          <>
            <span className="font-semibold text-slate-100">#{selected.seq}</span>{' '}
            <span className="text-slate-300">{selected.cameraName}</span>{' '}
            <span className="text-slate-500">({selected.cameraExternalId})</span>{' '}
            <span className="text-slate-400 tabular-nums">
              · {formatTime(selected.ts)} · +
              {formatDuration(elapsedSeconds(sightings, selected.seq))}
            </span>{' '}
            <span
              className="ml-1 inline-block rounded border px-2 py-0.5 text-[11px] font-medium"
              style={{
                borderColor: LINK_STYLE[selected.linkMethod].stroke,
                color: LINK_STYLE[selected.linkMethod].fill,
              }}
            >
              {LINK_STYLE[selected.linkMethod].label} · {selected.linkConfidence.toFixed(2)}
            </span>
          </>
        )}
      </p>
    </section>
  );
}

function formatTime(iso: string | undefined): string {
  if (iso === undefined) return '—';
  return iso.replace('T', ' ').replace('Z', '').slice(0, 19);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m ${String(s % 60)}s`;
  return `${String(Math.floor(s / 3600))}h ${String(Math.floor((s % 3600) / 60))}m`;
}
