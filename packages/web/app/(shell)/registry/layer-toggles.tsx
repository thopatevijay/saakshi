'use client';

/**
 * Layer toggles — what is **drawn**, as opposed to what is **fetched**.
 *
 * The distinction is deliberate and visible in the UI copy. A filter narrows the query the API
 * runs; a toggle hides a slice of what came back, instantly, without a round trip. Both land in the
 * URL, so a shared link restores the whole screen.
 *
 * Every dimension the ticket names is here — department, camera type, mount, adapter kind, status,
 * trust band — with the band living in the legend, where the colours are.
 *
 * ## The `status` toggle is honest about being single-valued
 *
 * All thirty probed cameras sit at `status = unknown`: D1-05 and D1-06 write the health-check row
 * and the trust score but leave `cameras.status` at its default, so nothing has ever moved it. A
 * toggle over one bucket is not a filter, and rather than hide that, the control shows the real
 * distribution and says which values are absent. Health lives in the trust band meanwhile. Logged
 * to `BL-01`: `cameras.status` needs an owner.
 */
import { useId } from 'react';
import {
  ADAPTER_KINDS,
  CAMERA_MOUNTS,
  CAMERA_STATUSES,
  CAMERA_TYPES,
  type LayerState,
} from '@/src/lib/registry/query';

export interface DepartmentOption {
  id: string;
  code: string;
}

interface Group {
  dimension: keyof LayerState;
  title: string;
  note?: string;
  options: { value: string; label: string }[];
}

export function LayerToggles({
  layers,
  counts,
  departments,
  onToggle,
}: {
  layers: LayerState;
  /** `dimension:value` → how many cameras currently carry it. */
  counts: Record<string, number>;
  departments: DepartmentOption[];
  onToggle: (dimension: keyof LayerState, value: string) => void;
}) {
  const headingId = useId();

  const groups: Group[] = [
    {
      dimension: 'cameraType',
      title: 'Camera type',
      options: CAMERA_TYPES.map((v) => ({ value: v, label: v === 'ip' ? 'IP' : 'Analog' })),
    },
    {
      dimension: 'mount',
      title: 'Mount',
      options: CAMERA_MOUNTS.map((v) => ({ value: v, label: v })),
    },
    {
      dimension: 'adapterKind',
      title: 'Adapter',
      options: ADAPTER_KINDS.map((v) => ({ value: v, label: v })),
    },
    {
      dimension: 'status',
      title: 'Measured health',
      note: 'Separate from catalogue presence, and separate from the trust band. Nothing writes this column yet, so every camera reads `unknown` — see the note in the drawer.',
      options: CAMERA_STATUSES.map((v) => ({ value: v, label: v })),
    },
    {
      dimension: 'department',
      title: 'Department',
      options: departments.map((d) => ({ value: d.id, label: d.code })),
    },
  ];

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div>
        <h3
          id={headingId}
          className="text-xs font-semibold uppercase tracking-wide text-slate-400"
        >
          Layers
        </h3>
        <p className="mt-1 text-[11px] text-slate-500">
          Hides pins already loaded — no refetch. Filters, above, change what is queried.
        </p>
      </div>

      {groups
        .filter((group) => group.options.length > 0)
        .map((group) => (
          <fieldset key={group.dimension} className="space-y-1.5">
            <legend className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              {group.title}
            </legend>
            {group.note === undefined ? null : (
              <p className="text-[11px] leading-relaxed text-slate-600">{group.note}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {group.options.map((option) => {
                const isHidden = (layers[group.dimension] as ReadonlySet<string>).has(option.value);
                const count = counts[`${group.dimension}:${option.value}`] ?? 0;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={!isHidden}
                    data-layer={`${group.dimension}:${option.value}`}
                    onClick={() => {
                      onToggle(group.dimension, option.value);
                    }}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                      isHidden
                        ? 'border-slate-800 bg-slate-900/30 text-slate-600 line-through'
                        : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:border-sky-800 hover:text-sky-200'
                    }`}
                  >
                    {option.label}
                    <span className="ml-1.5 tabular-nums text-slate-500">{count}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
    </section>
  );
}
