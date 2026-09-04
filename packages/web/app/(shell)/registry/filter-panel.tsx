'use client';

/**
 * The filter panel — bound to D1-02's query contract, one control per parameter.
 *
 * Every field here is a **server-side** filter: it goes into the URL, the page refetches, and the
 * API does the narrowing. That matters at estate scale — the bbox filter runs on the PostGIS GiST
 * index, and a 100k-camera registry filtered to one district never puts 100k rows on the wire.
 *
 * ## The trust range and the null that is not in it
 *
 * `trustMin`/`trustMax` filter on the stored score, and D1-02 is explicit that
 * **`trustScore: null` matches neither**. So the moment either bound is set, every never-probed
 * camera silently leaves the result — which would look like a shrinking estate rather than a
 * narrowed one. The panel says so, in place, rather than letting the operator discover it.
 */
import { useId } from 'react';
import {
  ADAPTER_KINDS,
  CAMERA_MOUNTS,
  CAMERA_STATUSES,
  CAMERA_TYPES,
  GEOMETRY_CLASSES,
  type FilterPatch,
  type RegistryFilters,
} from '@/src/lib/registry/query';
import type { DepartmentOption } from './layer-toggles';

const SELECT_CLASS =
  'w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-400';

export function FilterPanel({
  filters,
  districts,
  departments,
  onChange,
  onReset,
  busy,
}: {
  filters: RegistryFilters;
  districts: string[];
  departments: DepartmentOption[];
  onChange: (patch: FilterPatch) => void;
  onReset: () => void;
  busy: boolean;
}) {
  const headingId = useId();
  const trustNarrows = filters.trustMin !== undefined || filters.trustMax !== undefined;

  const select = (
    label: string,
    key: keyof RegistryFilters,
    options: readonly { value: string; label: string }[],
  ) => (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
      <select
        className={SELECT_CLASS}
        data-filter={key}
        value={filters[key] === undefined ? '' : String(filters[key])}
        onChange={(event) => {
          onChange({ [key]: event.target.value === '' ? undefined : event.target.value });
        }}
      >
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Filters
        </h3>
        <button
          type="button"
          onClick={onReset}
          className="text-[11px] text-sky-400 hover:text-sky-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          Reset
        </button>
      </div>

      <label className="block space-y-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Search
        </span>
        <input
          type="search"
          data-filter="q"
          defaultValue={filters.q ?? ''}
          placeholder="id, name or address"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onChange({ q: event.currentTarget.value.trim() || undefined });
            }
          }}
          onBlur={(event) => {
            const next = event.currentTarget.value.trim() || undefined;
            if (next !== filters.q) onChange({ q: next });
          }}
          className={SELECT_CLASS}
        />
      </label>

      {select(
        'Department',
        'departmentId',
        departments.map((d) => ({ value: d.id, label: d.code })),
      )}
      {select(
        'District',
        'district',
        districts.map((d) => ({ value: d, label: d })),
      )}
      {select(
        'Camera type',
        'cameraType',
        CAMERA_TYPES.map((v) => ({ value: v, label: v === 'ip' ? 'IP' : 'Analog' })),
      )}
      {select(
        'Mount',
        'mount',
        CAMERA_MOUNTS.map((v) => ({ value: v, label: v })),
      )}
      {select(
        'Adapter',
        'adapterKind',
        ADAPTER_KINDS.map((v) => ({ value: v, label: v })),
      )}
      {select(
        'Health status',
        'status',
        CAMERA_STATUSES.map((v) => ({ value: v, label: v })),
      )}
      {select(
        'Geometry class',
        'geometryClass',
        GEOMETRY_CLASSES.map((v) => ({ value: v, label: v.replaceAll('_', ' ') })),
      )}

      <fieldset className="space-y-1">
        <legend className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Trust score
        </legend>
        <div className="flex items-center gap-2">
          {(['trustMin', 'trustMax'] as const).map((key) => (
            <input
              key={key}
              type="number"
              min={0}
              max={100}
              data-filter={key}
              placeholder={key === 'trustMin' ? 'min' : 'max'}
              defaultValue={filters[key] ?? ''}
              onBlur={(event) => {
                const raw = event.currentTarget.value.trim();
                const value = raw === '' ? undefined : Number(raw);
                if (value !== filters[key]) onChange({ [key]: value });
              }}
              className={SELECT_CLASS}
            />
          ))}
        </div>
        {trustNarrows ? (
          <p className="text-[11px] leading-relaxed text-amber-500/80">
            A score range excludes never-probed cameras entirely —{' '}
            <code className="text-amber-400">null</code> matches neither bound. Their absence here is
            the filter working, not the estate shrinking.
          </p>
        ) : null}
      </fieldset>

      <p className="text-[11px] leading-relaxed text-slate-500">
        {busy ? 'Refetching…' : 'Filters run on the API and are shareable — they live in the URL.'}
      </p>
    </section>
  );
}
