/**
 * The alert queue's state machine (D2-07, AC 1, AC 4, AC 5, AC 9).
 *
 * The row-shift criterion is the one that cannot be checked by looking at the screen — it is a
 * race, and it only ever bites when an operator is mid-verdict. So it is asserted here, on the
 * reducer, where an arriving alert and a focused row can be put in the same instant deliberately.
 */
import { describe, expect, it } from 'vitest';
import type {
  AlertWithRetention as AlertRecord,
  AlertSeverity,
  WatchlistCategory,
} from '@saakshi/shared';
import {
  applyTransition,
  cursorIndex,
  dismissBlocked,
  emptyQueue,
  mergePending,
  moveCursor,
  receive,
  replace,
  rollbackTransition,
  settleTransition,
  sortAlerts,
  transitionAllowed,
  windowFor,
} from './queue';

/** A minimal but structurally honest `AlertRecord`. Only the fields the reducer reads are varied. */
function alert(
  id: string,
  overrides: {
    severity?: AlertSeverity;
    categoryRank?: number;
    category?: WatchlistCategory;
    lastSeenAt?: string;
    status?: AlertRecord['status'];
  } = {},
): AlertRecord {
  const lastSeenAt = overrides.lastSeenAt ?? '2026-09-05T00:00:00.000Z';
  return {
    id,
    watchlistEntryId: `w-${id}`,
    sightingId: `s-${id}`,
    cameraId: `c-${id}`,
    ts: lastSeenAt,
    lastSeenAt,
    sightingCount: 1,
    lastObservedPlate: 'GJ35U07',
    category: overrides.category ?? 'stolen_vehicle',
    sourceSystem: 'eGujCop',
    severity: overrides.severity ?? 'low',
    matchType: 'fuzzy',
    matchDistance: 0.7,
    confidence: 0.34515,
    dedupeKey: `d-${id}`,
    dedupeWindowStart: lastSeenAt,
    status: overrides.status ?? 'new',
    ackedBy: null,
    ackedAt: null,
    statusChangedBy: null,
    statusChangedAt: null,
    createdAt: lastSeenAt,
    // D3-05. Queue ordering is indifferent to the retention clock, and `null` is the shape a live
    // SSE frame arrives with — the case most likely to reach this reducer.
    retention: null,
    reason: {
      severityBasis: { categoryRank: overrides.categoryRank ?? 1 },
    },
  } as unknown as AlertRecord;
}

/* ── AC 1 ───────────────────────────────────────────────────────────────────────────────────── */

describe('AC 1 — a live alert never moves the row under the cursor', () => {
  it('buffers an arriving alert while a row is focused, instead of inserting above it', () => {
    const state = {
      ...emptyQueue([alert('b'), alert('c')]),
      cursorId: 'b',
    };
    const next = receive(state, alert('a', { severity: 'critical', categoryRank: 1 }), {
      sort: 'severity',
      idle: false,
    });

    expect(next.pending.map((a) => a.id)).toEqual(['a']);
    expect(next.alerts.map((a) => a.id)).toEqual(['b', 'c']);
    // The whole point: the focused row is still at the same index.
    expect(cursorIndex(next)).toBe(0);
  });

  it('merges straight in when nobody is working the queue — "live without a refresh"', () => {
    const state = emptyQueue([alert('b', { categoryRank: 2 })]);
    const next = receive(state, alert('a', { categoryRank: 1 }), { sort: 'severity', idle: true });
    expect(next.pending).toHaveLength(0);
    expect(next.alerts.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('applies an update to a visible row in place, without reordering it', () => {
    const state = {
      ...emptyQueue([
        alert('a', { categoryRank: 2, lastSeenAt: '2026-09-05T00:00:00.000Z' }),
        alert('b', { categoryRank: 3 }),
      ]),
      cursorId: 'b',
    };
    const bumped = { ...alert('a', { categoryRank: 2 }), sightingCount: 23 };
    const next = receive(state, bumped, { sort: 'severity', idle: false });

    expect(next.alerts.map((a) => a.id)).toEqual(['a', 'b']);
    expect(next.alerts[0]?.sightingCount).toBe(23);
    expect(next.pending).toHaveLength(0);
    expect(cursorIndex(next)).toBe(1);
  });

  it('de-duplicates a redelivery: the same id twice is one buffered row', () => {
    const first = receive(emptyQueue([]), alert('a'), { sort: 'severity', idle: false });
    const second = receive(
      first,
      { ...alert('a'), sightingCount: 4 },
      {
        sort: 'severity',
        idle: false,
      },
    );
    expect(second.pending).toHaveLength(1);
    expect(second.pending[0]?.sightingCount).toBe(4);
  });

  it('flushes the buffer only on an explicit merge, and sorts it in properly', () => {
    const state = {
      ...emptyQueue([alert('b', { categoryRank: 2 })]),
      pending: [alert('a', { categoryRank: 1 })],
      cursorId: 'b',
    };
    const merged = mergePending(state, 'severity');
    expect(merged.alerts.map((a) => a.id)).toEqual(['a', 'b']);
    expect(merged.pending).toHaveLength(0);
    // The cursor follows the alert, not the index — the operator keeps their row.
    expect(merged.cursorId).toBe('b');
    expect(cursorIndex(merged)).toBe(1);
  });
});

describe('sorting mirrors the API, so a merged alert lands where a refetch would put it', () => {
  it('sorts by categoryRank first and severity second (D2-06)', () => {
    const sorted = sortAlerts(
      [
        alert('low-rank-1', { categoryRank: 1, severity: 'low' }),
        alert('critical-rank-3', { categoryRank: 3, severity: 'critical' }),
        alert('medium-rank-1', { categoryRank: 1, severity: 'medium' }),
      ],
      'severity',
    );
    // Rank 1 outranks a critical at rank 3 — this is exactly what sorting on severity alone loses.
    expect(sorted.map((a) => a.id)).toEqual(['medium-rank-1', 'low-rank-1', 'critical-rank-3']);
  });

  it('sorts newest-activity-first under sort=recent, ignoring rank', () => {
    const sorted = sortAlerts(
      [
        alert('old', { categoryRank: 1, lastSeenAt: '2026-09-05T00:00:00.000Z' }),
        alert('new', { categoryRank: 5, lastSeenAt: '2026-09-05T01:00:00.000Z' }),
      ],
      'recent',
    );
    expect(sorted.map((a) => a.id)).toEqual(['new', 'old']);
  });

  it('is a total order, so two identical timestamps cannot swap on re-render', () => {
    const a = alert('aaa', { lastSeenAt: '2026-09-05T00:00:00.000Z' });
    const b = alert('bbb', { lastSeenAt: '2026-09-05T00:00:00.000Z' });
    expect(sortAlerts([a, b], 'recent').map((x) => x.id)).toEqual(
      sortAlerts([b, a], 'recent').map((x) => x.id),
    );
  });
});

/* ── AC 4 and AC 5 ──────────────────────────────────────────────────────────────────────────── */

describe('AC 4 — ack/dismiss/escalate are optimistic and roll back', () => {
  it('paints the new status immediately, in place', () => {
    const state = emptyQueue([alert('a'), alert('b')]);
    const result = applyTransition(state, 'a', 'ack', 'officer-1', '2026-09-05T02:00:00.000Z');
    expect(result).not.toBeNull();
    if (result === null) return;

    expect(result.state.alerts[0]?.status).toBe('ack');
    expect(result.state.alerts[0]?.ackedBy).toBe('officer-1');
    expect(result.state.alerts[0]?.ackedAt).toBe('2026-09-05T02:00:00.000Z');
    expect(result.state.alerts.map((a) => a.id)).toEqual(['a', 'b']);
    expect(result.previous.status).toBe('new');
  });

  it('restores the record exactly on a server error — including its index', () => {
    const state = emptyQueue([alert('a'), alert('b')]);
    const applied = applyTransition(state, 'a', 'dismissed', 'officer-1');
    expect(applied).not.toBeNull();
    if (applied === null) return;

    const rolled = rollbackTransition(applied.state, 'a');
    expect(rolled.alerts[0]).toEqual(state.alerts[0]);
    expect(rolled.alerts.map((x) => x.id)).toEqual(['a', 'b']);
    expect(rolled.inFlight).toEqual({});
  });

  it('takes the server record when the transition succeeds', () => {
    const state = emptyQueue([alert('a')]);
    const applied = applyTransition(state, 'a', 'escalated', 'officer-1');
    expect(applied).not.toBeNull();
    if (applied === null) return;

    const server = { ...alert('a'), status: 'escalated' as const, statusChangedBy: 'server-truth' };
    const settled = settleTransition(applied.state, server);
    expect(settled.alerts[0]?.statusChangedBy).toBe('server-truth');
    expect(settled.inFlight).toEqual({});
  });

  it('keeps an in-flight optimistic row when a refetch lands mid-transition', () => {
    const state = emptyQueue([alert('a')]);
    const applied = applyTransition(state, 'a', 'ack', 'officer-1');
    expect(applied).not.toBeNull();
    if (applied === null) return;

    // The server has not seen the ack yet. Flickering back to `new` would look like it failed.
    const refetched = replace(applied.state, [alert('a', { status: 'new' })], 'severity');
    expect(refetched.alerts[0]?.status).toBe('ack');
  });

  it('drops a cursor and an expansion that the refetch no longer contains', () => {
    const state = { ...emptyQueue([alert('a')]), cursorId: 'a', expandedId: 'a' };
    const refetched = replace(state, [alert('z')], 'severity');
    expect(refetched.cursorId).toBeNull();
    expect(refetched.expandedId).toBeNull();
  });

  it('returns null for an id that is not in the queue rather than inventing a row', () => {
    expect(applyTransition(emptyQueue([alert('a')]), 'ghost', 'ack', 'o')).toBeNull();
  });
});

describe('AC 5 — dismiss without a reason is blocked', () => {
  it('refuses an empty or whitespace-only reason', () => {
    expect(dismissBlocked('')).toBe(true);
    expect(dismissBlocked('   ')).toBe(true);
    expect(dismissBlocked('\n\t')).toBe(true);
  });

  it('accepts a real reason', () => {
    expect(dismissBlocked('plate region illegible, not this vehicle')).toBe(false);
  });
});

describe('the lifecycle graph and RBAC both gate a button', () => {
  it('refuses every transition out of dismissed — it is terminal', () => {
    const dismissed = alert('a', { status: 'dismissed' });
    expect(transitionAllowed(dismissed, 'ack', true)).toBe(false);
    expect(transitionAllowed(dismissed, 'escalated', true)).toBe(false);
  });

  it('allows an operator to ack, dismiss or escalate a new alert', () => {
    const fresh = alert('a');
    for (const to of ['ack', 'dismissed', 'escalated'] as const) {
      expect(transitionAllowed(fresh, to, true)).toBe(true);
    }
  });

  it('offers nothing to a role that may not act — an auditor reads but cannot transition', () => {
    expect(transitionAllowed(alert('a'), 'ack', false)).toBe(false);
  });
});

describe('the keyboard cursor', () => {
  const state = emptyQueue([alert('a'), alert('b'), alert('c')]);

  it('takes the first row on j from nothing and the last on k', () => {
    expect(moveCursor(state, 1).cursorId).toBe('a');
    expect(moveCursor(state, -1).cursorId).toBe('c');
  });

  it('clamps rather than wrapping — wrapping loses an operator s place in a long queue', () => {
    const atEnd = { ...state, cursorId: 'c' };
    expect(moveCursor(atEnd, 1).cursorId).toBe('c');
    const atStart = { ...state, cursorId: 'a' };
    expect(moveCursor(atStart, -1).cursorId).toBe('a');
  });

  it('does nothing on an empty queue', () => {
    expect(moveCursor(emptyQueue([]), 1).cursorId).toBeNull();
  });
});

/* ── AC 9 ───────────────────────────────────────────────────────────────────────────────────── */

describe('AC 9 — 500 rows are virtualised', () => {
  const base = {
    viewportHeight: 800,
    count: 500,
    rowHeight: 96,
    expandedIndex: -1,
    detailHeight: 0,
  };

  it('puts a small slice of 500 rows in the DOM, not 500', () => {
    const win = windowFor({ ...base, scrollTop: 0 });
    expect(win.end - win.start).toBeLessThan(30);
    expect(win.totalHeight).toBe(500 * 96);
  });

  it('keeps the scroll height exact so the scrollbar does not lie', () => {
    const win = windowFor({ ...base, scrollTop: 12_000 });
    expect(win.padTop + (win.end - win.start) * 96 + win.padBottom).toBe(win.totalHeight);
  });

  it('renders the rows that are actually on screen', () => {
    const win = windowFor({ ...base, scrollTop: 9600 });
    expect(win.start).toBeLessThanOrEqual(100);
    expect(win.end).toBeGreaterThanOrEqual(108);
  });

  it('accounts for the expanded panel in every offset below it', () => {
    const win = windowFor({
      ...base,
      scrollTop: 0,
      expandedIndex: 2,
      detailHeight: 400,
      overscan: 0,
    });
    expect(win.totalHeight).toBe(500 * 96 + 400);
    // Row 3 sits below the panel, so the window reaches fewer rows in the same viewport.
    expect(win.end).toBeLessThan(windowFor({ ...base, scrollTop: 0, overscan: 0 }).end);
  });

  it('does not fall over on an empty queue', () => {
    expect(windowFor({ ...base, count: 0, scrollTop: 0 })).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0,
      totalHeight: 0,
    });
  });
});
