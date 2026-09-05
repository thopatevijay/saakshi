'use client';

/**
 * The evidence strip (D2-08) — the crops, in chronological order, in the order the API returned.
 *
 * **This is the panel the rehearsal is judged on.** The ticket's last acceptance criterion is a
 * human looking at these crops one by one and saying whether every returned sighting is genuinely
 * that vehicle. So the strip is not decoration: each tile carries the position in the route, the
 * camera, the time, the raw OCR text next to the registration searched for, and the link method
 * with its confidence — everything needed to disagree with the machine.
 *
 * **A missing crop is shown, not hidden.** On the measured estate no sighting has a crop at all
 * (the analytics worker stores one per best shot, and none has been selected on this corpus), and
 * a strip that quietly rendered nothing would look like a bug or, worse, like there was no
 * evidence to check. The empty tile says which of the two it is.
 *
 * The strip never re-sorts. Order is the API's, which is by PTS-derived timestamp — re-sorting in
 * the browser would be a second ordering rule that could drift from the one the export uses.
 */
import { LINK_STYLE } from '@/src/lib/trace/geojson';
import type { TraceSighting } from './types';

export interface EvidenceStripProps {
  sightings: readonly TraceSighting[];
  selectedSeq: number | null;
  onSelect: (seq: number | null) => void;
  plate: string;
}

export function EvidenceStrip({ sightings, selectedSeq, onSelect, plate }: EvidenceStripProps) {
  if (sightings.length === 0) return null;
  const withCrops = sightings.filter((s) => s.cropUrl !== null).length;

  return (
    <section
      className="rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-4"
      data-testid="evidence-strip"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
          Evidence · chronological
        </h2>
        <p className="text-xs text-slate-400 tabular-nums">
          {withCrops} of {sightings.length} sighting{sightings.length === 1 ? '' : 's'} has a stored
          crop
        </p>
      </div>

      <ol className="mt-3 flex gap-3 overflow-x-auto pb-2" data-testid="evidence-list">
        {sightings.map((s) => {
          const style = LINK_STYLE[s.linkMethod];
          const isSelected = s.seq === selectedSeq;
          return (
            <li key={s.sightingId} data-seq={s.seq} className="shrink-0">
              <button
                type="button"
                onClick={() => {
                  onSelect(isSelected ? null : s.seq);
                }}
                aria-pressed={isSelected}
                className={`w-52 rounded-md border p-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${
                  isSelected
                    ? 'border-sky-500 bg-sky-950/30'
                    : 'border-slate-700 bg-slate-900/60 hover:border-sky-800'
                }`}
              >
                <div className="flex h-28 items-center justify-center overflow-hidden rounded bg-slate-950">
                  {s.cropUrl === null ? (
                    <span className="px-3 text-center text-[11px] text-slate-500">
                      {s.cropUri === null
                        ? 'No crop stored for this sighting'
                        : 'Crop stored, but no object store is configured'}
                    </span>
                  ) : (
                    // A plain <img>, deliberately: the crop is a presigned object-store URL with a
                    // short life, and next/image would proxy and cache a URL that expires.
                    <img
                      src={s.cropUrl}
                      alt={`Evidence crop ${String(s.seq)} — ${s.cameraName}, ${s.ts}`}
                      className="max-h-28 w-auto"
                    />
                  )}
                </div>

                <p className="mt-2 flex items-baseline gap-1.5 text-xs">
                  <span className="font-semibold text-slate-100">#{s.seq}</span>
                  <span className="truncate text-slate-300">{s.cameraName}</span>
                </p>
                <p className="text-[11px] text-slate-500 tabular-nums">
                  {s.ts.replace('T', ' ').replace('Z', '').slice(0, 19)}
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  read <span className="font-mono text-slate-200">{s.plateRawText}</span>
                  {s.plateNormalized === plate ? null : (
                    <span className="text-amber-400"> ≠ {plate}</span>
                  )}
                </p>
                <p
                  className="mt-1 inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ borderColor: style.stroke, color: style.fill }}
                >
                  {style.label} · {s.linkConfidence.toFixed(2)}
                </p>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
