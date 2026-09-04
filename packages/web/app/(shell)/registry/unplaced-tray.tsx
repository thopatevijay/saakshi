'use client';

/**
 * The cameras the map cannot draw.
 *
 * ## Why this is a feature and not an apology
 *
 * The upstream catalogue is a bare `[{id, name}]` array. It supplies no coordinates, so the thirty
 * cameras with **real, measured** trust scores are exactly the thirty the map cannot place. A GIS
 * screen that showed only the placeable ones would report a clean, geolocated estate and silently
 * drop every camera anybody has actually measured — the most flattering possible lie.
 *
 * So they are listed, counted, coloured by their real band, and openable into the same drawer as a
 * pin. **A registry that cannot place a camera is itself a Pillar 1 finding**: an operator who
 * cannot say where a camera is cannot use its footage to reconstruct a route, and that gap belongs
 * on screen rather than in a footnote.
 */
import { BAND_STYLE, bandKeyOf } from '@/src/lib/registry/trust';
import type { MappableCamera } from '@/src/lib/registry/geojson';

export function UnplacedTray({
  cameras,
  selected,
  onSelect,
}: {
  cameras: MappableCamera[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (cameras.length === 0) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Not on the map
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          Every camera in this result has coordinates. Nothing is hidden from the map.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="unplaced-heading"
      className="flex min-h-0 flex-col rounded-lg border border-amber-900/40 bg-amber-950/10"
    >
      <div className="border-b border-amber-900/30 px-4 py-3">
        <h3 id="unplaced-heading" className="text-xs font-semibold uppercase tracking-wide text-amber-400">
          Not on the map · {cameras.length}
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
          The registry holds no coordinates for {cameras.length === 1 ? 'this camera' : 'these cameras'}.
          They are measured and scored — the gap is location, not health. The upstream catalogue
          publishes only an id and a name, so a coordinate has to be added by import or by hand
          before a route can be reconstructed through {cameras.length === 1 ? 'it' : 'them'}.
        </p>
      </div>

      <ul className="min-h-0 flex-1 divide-y divide-slate-800/60 overflow-y-auto">
        {cameras.map((camera) => {
          const style = BAND_STYLE[bandKeyOf(camera.band)];
          const isSelected = camera.id === selected;
          return (
            <li key={camera.id}>
              <button
                type="button"
                data-unplaced={camera.externalId}
                onClick={() => {
                  onSelect(camera.id);
                }}
                className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-xs hover:bg-slate-900/60 ${
                  isSelected ? 'bg-sky-950/40' : ''
                }`}
              >
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: style.fill ?? 'transparent',
                    boxShadow: `inset 0 0 0 ${style.fill === null ? '2px' : '1px'} ${style.stroke}`,
                  }}
                />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-slate-200">{camera.externalId}</span>
                  <span className="ml-2 text-slate-500">{camera.name}</span>
                </span>
                <span className="shrink-0 tabular-nums text-slate-400">
                  {camera.trustScore === null ? '—' : camera.trustScore.toFixed(0)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
