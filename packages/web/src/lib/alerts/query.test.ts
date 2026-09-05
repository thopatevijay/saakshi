/**
 * The alert queue's URL contract (D2-07, AC 6 — "all filters compose and persist in the URL").
 *
 * The round trip is the criterion: whatever the filter row can produce must survive being written
 * to the address bar and read back, or a shift handover by pasted link silently changes the queue.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMIT,
  DEFAULT_SORT,
  EMPTY_ALERT_QUERY,
  activeFilterCount,
  alertsHref,
  parseAlertQuery,
  toApiQuery,
  toSearchParams,
  type AlertQueryState,
} from './query';

const CAMERA = '54860008-d328-4886-9285-f33b914171ba';
const DEPARTMENT = '7b2704bf-25ee-4510-ab20-61735d6ea6ab';

const SHAPES: { name: string; state: AlertQueryState }[] = [
  { name: 'empty', state: EMPTY_ALERT_QUERY },
  { name: 'status only', state: { ...EMPTY_ALERT_QUERY, status: 'new' } },
  { name: 'severity only', state: { ...EMPTY_ALERT_QUERY, severity: 'medium' } },
  { name: 'category only', state: { ...EMPTY_ALERT_QUERY, category: 'stolen_vehicle' } },
  { name: 'match type only', state: { ...EMPTY_ALERT_QUERY, matchType: 'fuzzy' } },
  { name: 'camera only', state: { ...EMPTY_ALERT_QUERY, cameraId: CAMERA } },
  { name: 'department only', state: { ...EMPTY_ALERT_QUERY, departmentId: DEPARTMENT } },
  {
    name: 'time range only',
    state: {
      ...EMPTY_ALERT_QUERY,
      from: '2026-09-05T00:00:00.000Z',
      to: '2026-09-05T01:00:00.000Z',
    },
  },
  { name: 'recent sort', state: { ...EMPTY_ALERT_QUERY, sort: 'recent' } },
  { name: 'non-default limit', state: { ...EMPTY_ALERT_QUERY, limit: 25 } },
  {
    name: 'every filter at once',
    state: {
      status: 'ack',
      severity: 'low',
      category: 'blacklisted_vehicle',
      matchType: 'exact',
      cameraId: CAMERA,
      departmentId: DEPARTMENT,
      from: '2026-09-05T00:00:00.000Z',
      to: '2026-09-05T02:00:00.000Z',
      sort: 'recent',
      limit: 200,
    },
  },
];

describe('AC 6 — every filter composes and survives the URL', () => {
  for (const shape of SHAPES) {
    it(`round-trips: ${shape.name}`, () => {
      expect(parseAlertQuery(toSearchParams(shape.state))).toEqual(shape.state);
    });
  }

  it('writes nothing for an unfiltered queue, so /alerts stays /alerts', () => {
    expect(alertsHref(EMPTY_ALERT_QUERY)).toBe('/alerts');
    expect(toSearchParams(EMPTY_ALERT_QUERY).toString()).toBe('');
  });

  it('composes eight filters into one address', () => {
    const state = SHAPES[SHAPES.length - 1]?.state;
    expect(state).toBeDefined();
    if (state === undefined) return;
    expect(activeFilterCount(state)).toBe(8);
    const href = alertsHref(state);
    for (const key of [
      'status=ack',
      'severity=low',
      'category=blacklisted_vehicle',
      'match=exact',
      `camera=${CAMERA}`,
      `department=${DEPARTMENT}`,
      'from=',
      'to=',
    ]) {
      expect(href).toContain(key);
    }
  });

  it('counts no filters on an empty query', () => {
    expect(activeFilterCount(EMPTY_ALERT_QUERY)).toBe(0);
  });
});

describe('a hand-edited URL cannot break the queue', () => {
  it('drops an unknown enum value rather than sending it to the API', () => {
    const parsed = parseAlertQuery(new URLSearchParams('severity=catastrophic&status=pending'));
    expect(parsed.severity).toBeNull();
    expect(parsed.status).toBeNull();
  });

  it('drops a non-uuid camera or department', () => {
    const parsed = parseAlertQuery(new URLSearchParams('camera=cam07&department=traffic'));
    expect(parsed.cameraId).toBeNull();
    expect(parsed.departmentId).toBeNull();
  });

  it('drops an unparseable instant', () => {
    expect(parseAlertQuery(new URLSearchParams('from=yesterday')).from).toBeNull();
  });

  it('clamps the limit to the API maximum and falls back on nonsense', () => {
    expect(parseAlertQuery(new URLSearchParams('limit=9999')).limit).toBe(200);
    expect(parseAlertQuery(new URLSearchParams('limit=0')).limit).toBe(1);
    expect(parseAlertQuery(new URLSearchParams('limit=abc')).limit).toBe(DEFAULT_LIMIT);
  });

  it('swaps a reversed window instead of returning an empty queue', () => {
    const parsed = parseAlertQuery(
      new URLSearchParams('from=2026-09-05T02:00:00Z&to=2026-09-05T01:00:00Z'),
    );
    expect(parsed.from).toBe('2026-09-05T01:00:00.000Z');
    expect(parsed.to).toBe('2026-09-05T02:00:00.000Z');
  });

  it('defaults the sort to severity — categoryRank first, per D2-06', () => {
    expect(parseAlertQuery(new URLSearchParams('')).sort).toBe('severity');
    expect(DEFAULT_SORT).toBe('severity');
  });

  it('reads Next.js searchParams objects as well as URLSearchParams', () => {
    expect(parseAlertQuery({ severity: 'high', match: ['fuzzy', 'exact'] })).toMatchObject({
      severity: 'high',
      matchType: 'fuzzy',
    });
  });
});

describe('the wire query is D2-06 contract, not the URL shape', () => {
  it('renames the short URL keys onto the API names', () => {
    const api = toApiQuery({
      ...EMPTY_ALERT_QUERY,
      matchType: 'fuzzy',
      cameraId: CAMERA,
      departmentId: DEPARTMENT,
      from: '2026-09-05T00:00:00.000Z',
      to: '2026-09-05T01:00:00.000Z',
    });
    expect(api).toMatchObject({
      matchType: 'fuzzy',
      cameraId: CAMERA,
      departmentId: DEPARTMENT,
      since: '2026-09-05T00:00:00.000Z',
      until: '2026-09-05T01:00:00.000Z',
      sort: 'severity',
    });
  });

  it('omits absent filters entirely rather than sending nulls', () => {
    const api = toApiQuery(EMPTY_ALERT_QUERY);
    expect(Object.keys(api).sort()).toEqual(['limit', 'sort']);
  });

  it('carries a keyset cursor when one is supplied', () => {
    expect(toApiQuery(EMPTY_ALERT_QUERY, '2026-09-05T00:00:00.000Z').cursor).toBe(
      '2026-09-05T00:00:00.000Z',
    );
  });
});
