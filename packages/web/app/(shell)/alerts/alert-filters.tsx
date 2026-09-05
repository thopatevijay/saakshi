'use client';

/**
 * The filter row.
 *
 * Every control writes straight into `AlertQueryState`, which is the URL (`src/lib/alerts/query.ts`).
 * There is no "apply" button and no local draft: a filter an operator has selected but not applied
 * is a filter they think is on, and on a queue that decides what a shift looks at, that is worse
 * than a round trip. The time range is the one exception in shape only — two `datetime-local`
 * inputs, converted to ISO on change.
 *
 * `department` is resolved by the API (D2-07 added `departmentId` to `/api/v1/alerts`) rather than
 * filtered here: the queue is keyset-paginated, and a client-side filter would drop rows out of a
 * page and then page straight past them.
 */
import { AlertSeverity, AlertStatus, MatchType, WatchlistCategory } from '@saakshi/shared';
import { CATEGORY_LABEL, SEVERITY_STYLE, STATUS_LABEL } from '@/src/lib/alerts/present';
import { EMPTY_ALERT_QUERY, activeFilterCount, type AlertQueryState } from '@/src/lib/alerts/query';
import type { FilterOptions } from './types';

const FIELD =
  'rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-400';
const LABEL = 'text-[10px] font-semibold tracking-wide text-slate-500 uppercase';

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in *local* time; the state holds a UTC instant. */
function toLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export interface AlertFiltersProps {
  query: AlertQueryState;
  options: FilterOptions;
  onChange: (next: AlertQueryState) => void;
}

export function AlertFilters({ query, options, onChange }: AlertFiltersProps) {
  const set = <K extends keyof AlertQueryState>(key: K, value: AlertQueryState[K]): void => {
    onChange({ ...query, [key]: value });
  };
  const active = activeFilterCount(query);

  return (
    <form
      data-testid="alert-filters"
      role="search"
      aria-label="Filter the alert queue"
      onSubmit={(event) => {
        event.preventDefault();
      }}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3"
    >
      <label className="flex flex-col gap-1">
        <span className={LABEL}>Status</span>
        <select
          data-testid="filter-status"
          className={FIELD}
          value={query.status ?? ''}
          onChange={(e) => {
            set('status', e.target.value === '' ? null : (e.target.value as AlertStatus));
          }}
        >
          <option value="">Any status</option>
          {AlertStatus.options.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Severity</span>
        <select
          data-testid="filter-severity"
          className={FIELD}
          value={query.severity ?? ''}
          onChange={(e) => {
            set('severity', e.target.value === '' ? null : (e.target.value as AlertSeverity));
          }}
        >
          <option value="">Any severity</option>
          {AlertSeverity.options.map((severity) => (
            <option key={severity} value={severity}>
              {SEVERITY_STYLE[severity].label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Category</span>
        <select
          data-testid="filter-category"
          className={FIELD}
          value={query.category ?? ''}
          onChange={(e) => {
            set('category', e.target.value === '' ? null : (e.target.value as WatchlistCategory));
          }}
        >
          <option value="">Any category</option>
          {WatchlistCategory.options.map((category) => (
            <option key={category} value={category}>
              {CATEGORY_LABEL[category]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Match</span>
        <select
          data-testid="filter-match"
          className={FIELD}
          value={query.matchType ?? ''}
          onChange={(e) => {
            set('matchType', e.target.value === '' ? null : (e.target.value as MatchType));
          }}
        >
          <option value="">Exact and fuzzy</option>
          {MatchType.options.map((match) => (
            <option key={match} value={match}>
              {match === 'exact' ? 'Exact only' : 'Fuzzy only'}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Camera</span>
        <select
          data-testid="filter-camera"
          className={`${FIELD} max-w-56`}
          value={query.cameraId ?? ''}
          onChange={(e) => {
            set('cameraId', e.target.value === '' ? null : e.target.value);
          }}
        >
          <option value="">Any camera</option>
          {options.cameras.map((camera) => (
            <option key={camera.id} value={camera.id}>
              {camera.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Department</span>
        <select
          data-testid="filter-department"
          className={FIELD}
          value={query.departmentId ?? ''}
          onChange={(e) => {
            set('departmentId', e.target.value === '' ? null : e.target.value);
          }}
        >
          <option value="">Any department</option>
          {options.departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>From</span>
        <input
          type="datetime-local"
          data-testid="filter-from"
          className={FIELD}
          value={toLocalInput(query.from)}
          onChange={(e) => {
            set('from', fromLocalInput(e.target.value));
          }}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>To</span>
        <input
          type="datetime-local"
          data-testid="filter-to"
          className={FIELD}
          value={toLocalInput(query.to)}
          onChange={(e) => {
            set('to', fromLocalInput(e.target.value));
          }}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Order</span>
        <select
          data-testid="filter-sort"
          className={FIELD}
          value={query.sort}
          onChange={(e) => {
            set('sort', e.target.value === 'recent' ? 'recent' : 'severity');
          }}
        >
          {/* Category rank first, not severity — five categories, four severities (D2-06). */}
          <option value="severity">Most serious first</option>
          <option value="recent">Most recent first</option>
        </select>
      </label>

      <button
        type="button"
        data-testid="filter-clear"
        disabled={active === 0}
        onClick={() => {
          onChange({ ...EMPTY_ALERT_QUERY, sort: query.sort });
        }}
        className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      >
        Clear {active === 0 ? 'filters' : `${String(active)} filters`}
      </button>
    </form>
  );
}
