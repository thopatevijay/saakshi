'use client';

/**
 * The legend, which is also the band toggle.
 *
 * A legend that only names colours is a lookup table. This one carries **what each colour asserts**
 * and the live count behind it, and clicking a row hides that band — because the question an
 * operator actually has ("where are the cameras I cannot rely on?") is answered by removing the
 * ones they can.
 *
 * The two rows that matter most:
 *
 *   **Degraded** is not "usable with caveats". `cam22` scores 55 and is effectively blind
 *   (blur 0.011). D1-06 flagged it explicitly: a legend that implies amber means usable is wrong
 *   about that camera, so the wording says out-of-tolerance, not degraded-but-fine.
 *
 *   **Never probed** is drawn as a hollow ring, not a pale colour. Absence of evidence is not
 *   evidence of a bad camera, and it is the one distinction the whole screen exists to preserve.
 */
import { BAND_KEYS, BAND_STYLE, type BandKey } from '@/src/lib/registry/trust';

export function MapLegend({
  counts,
  hidden,
  onToggle,
}: {
  counts: Record<string, number>;
  hidden: ReadonlySet<BandKey>;
  onToggle: (band: BandKey) => void;
}) {
  return (
    <section aria-labelledby="legend-heading" className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3
          id="legend-heading"
          className="text-xs font-semibold uppercase tracking-wide text-slate-400"
        >
          Trust band
        </h3>
        <span className="text-[11px] text-slate-500">click to hide</span>
      </div>

      <ul className="space-y-1">
        {BAND_KEYS.map((band) => {
          const style = BAND_STYLE[band];
          const isHidden = hidden.has(band);
          const count = counts[band] ?? 0;
          return (
            <li key={band}>
              <button
                type="button"
                onClick={() => {
                  onToggle(band);
                }}
                aria-pressed={!isHidden}
                data-band={band}
                data-hidden={isHidden ? 'true' : 'false'}
                title={style.meaning}
                className={`flex w-full items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left text-xs transition ${
                  isHidden
                    ? 'border-slate-800 bg-slate-900/30 text-slate-600'
                    : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="size-3 shrink-0 rounded-full"
                  style={{
                    backgroundColor: style.fill ?? 'transparent',
                    boxShadow: `inset 0 0 0 ${style.fill === null ? '2px' : '1px'} ${style.stroke}`,
                    opacity: isHidden ? 0.35 : 1,
                  }}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{style.label}</span>
                <span className="tabular-nums text-slate-500">{count}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="pt-1 text-[11px] leading-relaxed text-slate-500">
        Bands come from the API, which resolves <span className="text-slate-400">dead</span> from
        the latest health check rather than from the stored score — an unreachable camera keeps its
        last good number. A cluster takes the <span className="text-slate-400">worst</span> band it
        contains, never an average.
      </p>
    </section>
  );
}
