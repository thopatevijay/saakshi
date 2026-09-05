/**
 * The alert queue's URL contract (D2-07).
 *
 * `/alerts?severity=medium&category=stolen_vehicle&match=fuzzy&status=new&camera=<uuid>&department=<uuid>&from=…&to=…&sort=severity`
 * is the whole screen state. That matters more here than on any other screen: a supervisor who
 * spots something says *"look at this"* and pastes an address, and a shift handover is a bookmark.
 * A filter held only in React state cannot be handed over.
 *
 * Pure and symmetric, like `trace/query.ts` and `registry/query.ts`: `parse(toSearchParams(state))`
 * must return `state`, and `query.test.ts` asserts it over every shape the screen can reach.
 * Defaults are never written, so an unfiltered queue is just `/alerts`.
 *
 * **The default sort is `severity`, not `recent`.** D2-06 is explicit that five watchlist categories
 * map onto four `alert_severity` values, so sorting on severity alone silently loses the ticket's
 * stated ordering; `sort=severity` makes the API order by `reason.severityBasis.categoryRank` first.
 * The monitoring order (`recent`) is one click away, and it is what the live indicator implies, but
 * the queue an officer opens cold should be in the order the policy says matters.
 */
import { AlertSeverity, AlertStatus, MatchType, WatchlistCategory } from '@saakshi/shared';

export type AlertSort = 'recent' | 'severity';

export interface AlertQueryState {
  status: AlertStatus | null;
  severity: AlertSeverity | null;
  category: WatchlistCategory | null;
  matchType: MatchType | null;
  /** Camera id. `null` is every camera. */
  cameraId: string | null;
  /** Department id — resolved server-side so keyset pagination stays correct. */
  departmentId: string | null;
  /** ISO instants bounding `lastSeenAt`. */
  from: string | null;
  to: string | null;
  sort: AlertSort;
  limit: number;
}

export const DEFAULT_SORT: AlertSort = 'severity';
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;

export const EMPTY_ALERT_QUERY: AlertQueryState = {
  status: null,
  severity: null,
  category: null,
  matchType: null,
  cameraId: null,
  departmentId: null,
  from: null,
  to: null,
  sort: DEFAULT_SORT,
  limit: DEFAULT_LIMIT,
};

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function read(source: ParamSource, key: string): string | null {
  if (source instanceof URLSearchParams) return source.get(key);
  const value = source[key];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** An enum member, or `null`. An unknown value is dropped rather than thrown — it came from a URL. */
function readEnum<T extends string>(
  source: ParamSource,
  key: string,
  allowed: readonly T[],
): T | null {
  const raw = read(source, key);
  if (raw === null) return null;
  return allowed.includes(raw as T) ? (raw as T) : null;
}

/** A UUID, or `null`. Validated here so a hand-edited URL cannot reach the API as a 400. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readUuid(source: ParamSource, key: string): string | null {
  const raw = read(source, key);
  return raw !== null && UUID.test(raw) ? raw.toLowerCase() : null;
}

function readInstant(source: ParamSource, key: string): string | null {
  const raw = read(source, key);
  if (raw === null || raw === '') return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function parseAlertQuery(source: ParamSource): AlertQueryState {
  const limitRaw = read(source, 'limit');
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);

  const from = readInstant(source, 'from');
  const to = readInstant(source, 'to');
  // A window whose end precedes its start returns nothing and looks like a broken queue. Swapping
  // is the only reading that can be right, and the filter row shows the swapped values back.
  const swap = from !== null && to !== null && Date.parse(to) < Date.parse(from);

  return {
    status: readEnum(source, 'status', AlertStatus.options),
    severity: readEnum(source, 'severity', AlertSeverity.options),
    category: readEnum(source, 'category', WatchlistCategory.options),
    matchType: readEnum(source, 'match', MatchType.options),
    cameraId: readUuid(source, 'camera'),
    departmentId: readUuid(source, 'department'),
    from: swap ? to : from,
    to: swap ? from : to,
    sort: readEnum<AlertSort>(source, 'sort', ['recent', 'severity']) ?? DEFAULT_SORT,
    limit:
      Number.isFinite(limit) && Number.isInteger(limit)
        ? Math.min(MAX_LIMIT, Math.max(1, limit))
        : DEFAULT_LIMIT,
  };
}

/** Only non-default values are written, so an unfiltered queue is a bare `/alerts`. */
export function toSearchParams(state: AlertQueryState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.status !== null) params.set('status', state.status);
  if (state.severity !== null) params.set('severity', state.severity);
  if (state.category !== null) params.set('category', state.category);
  if (state.matchType !== null) params.set('match', state.matchType);
  if (state.cameraId !== null) params.set('camera', state.cameraId);
  if (state.departmentId !== null) params.set('department', state.departmentId);
  if (state.from !== null) params.set('from', state.from);
  if (state.to !== null) params.set('to', state.to);
  if (state.sort !== DEFAULT_SORT) params.set('sort', state.sort);
  if (state.limit !== DEFAULT_LIMIT) params.set('limit', String(state.limit));
  return params;
}

export function alertsHref(state: AlertQueryState): string {
  const query = toSearchParams(state).toString();
  return query === '' ? '/alerts' : `/alerts?${query}`;
}

/** How many filters are narrowing the queue. Drives the "N filters · clear" affordance. */
export function activeFilterCount(state: AlertQueryState): number {
  return [
    state.status,
    state.severity,
    state.category,
    state.matchType,
    state.cameraId,
    state.departmentId,
    state.from,
    state.to,
  ].filter((value) => value !== null).length;
}

/**
 * The query the API is actually asked, with `undefined` for every absent filter.
 *
 * Separate from the URL shape on purpose: the URL is short and human (`match`, `camera`, `from`),
 * the wire is D2-06's contract (`matchType`, `cameraId`, `since`). Collapsing them would make one
 * of the two ugly, and renaming a URL parameter would silently break every bookmark.
 */
export interface AlertApiQuery {
  status?: AlertStatus;
  severity?: AlertSeverity;
  category?: WatchlistCategory;
  matchType?: MatchType;
  cameraId?: string;
  departmentId?: string;
  since?: string;
  until?: string;
  sort: AlertSort;
  limit: number;
  cursor?: string;
}

export function toApiQuery(state: AlertQueryState, cursor?: string): AlertApiQuery {
  return {
    ...(state.status === null ? {} : { status: state.status }),
    ...(state.severity === null ? {} : { severity: state.severity }),
    ...(state.category === null ? {} : { category: state.category }),
    ...(state.matchType === null ? {} : { matchType: state.matchType }),
    ...(state.cameraId === null ? {} : { cameraId: state.cameraId }),
    ...(state.departmentId === null ? {} : { departmentId: state.departmentId }),
    ...(state.from === null ? {} : { since: state.from }),
    ...(state.to === null ? {} : { until: state.to }),
    sort: state.sort,
    limit: state.limit,
    ...(cursor === undefined ? {} : { cursor }),
  };
}
