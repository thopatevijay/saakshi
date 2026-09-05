/**
 * The alert queue's state machine (D2-07) — pure, so the hard parts are testable without a DOM.
 *
 * Three things in here are the acceptance criteria rather than implementation detail:
 *
 * **1 · A live alert must never move the row under the cursor.** A control-room operator reaching
 * for `d` on the row they are reading, and having a higher-severity alert slide into that position
 * a frame earlier, is not a cosmetic bug — it dismisses the wrong alert. So an arriving alert is
 * *buffered* whenever anybody is working the queue (a row is focused, or the list is scrolled off
 * the top) and merged only on an explicit gesture. When nothing is focused and the list is at the
 * top, it merges itself, because "appears live without a refresh" is the other half of the same AC.
 *
 * **2 · A transition is optimistic and reversible.** The button paints instantly and the previous
 * record is kept; a non-2xx puts it back exactly as it was, including its position in the sort.
 * D2-06 warns that a 409 is a *normal* outcome — another operator may have moved the alert since
 * this queue rendered it — so rollback is a routine path, not an error path.
 *
 * **3 · Dismiss is the only transition that demands a reason.** Ack and escalate keep an alert in
 * play; dismiss is terminal by design (`ALERT_TRANSITIONS.dismissed` is empty), and a terminal
 * judgement with no recorded reason is exactly what an audit cannot reconstruct.
 *
 * Sorting mirrors the API's, so an alert merged from the stream lands where a refetch would have
 * put it. D2-06: **`categoryRank` first, severity second** — five categories map onto four severity
 * values, and severity alone silently loses the ticket's ordering.
 */
import { SEVERITY_ORDER, canTransition, type AlertRecord, type AlertStatus } from '@saakshi/shared';
import type { AlertSort } from './query';

export interface QueueState {
  /** What is rendered, in order. */
  alerts: AlertRecord[];
  /** Arrived on the stream, deliberately not merged yet. */
  pending: AlertRecord[];
  /** The keyboard cursor. `null` when nobody is working a row. */
  cursorId: string | null;
  /** The one expanded row, or `null`. One at a time: the virtualiser measures a single detail. */
  expandedId: string | null;
  /** id → the record as it was before an optimistic transition, for rollback. */
  inFlight: Record<string, AlertRecord>;
}

export function emptyQueue(alerts: AlertRecord[] = []): QueueState {
  return { alerts, pending: [], cursorId: null, expandedId: null, inFlight: {} };
}

/* ── ordering ───────────────────────────────────────────────────────────────────────────────── */

function compare(a: AlertRecord, b: AlertRecord, sort: AlertSort): number {
  if (sort === 'severity') {
    const rank = a.reason.severityBasis.categoryRank - b.reason.severityBasis.categoryRank;
    if (rank !== 0) return rank;
    const severity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (severity !== 0) return severity;
  }
  const recency = Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
  if (recency !== 0) return recency;
  // A total order, always: two alerts can share `lastSeenAt` to the millisecond, and an unstable
  // sort would let them swap places on every re-render — which is the row-shift this file exists
  // to prevent, arriving by a different door.
  return a.id.localeCompare(b.id);
}

export function sortAlerts(alerts: readonly AlertRecord[], sort: AlertSort): AlertRecord[] {
  return [...alerts].sort((a, b) => compare(a, b, sort));
}

/* ── the stream ─────────────────────────────────────────────────────────────────────────────── */

export interface ReceiveContext {
  sort: AlertSort;
  /** The list is scrolled to the top **and** no row is focused — nobody is mid-verdict. */
  idle: boolean;
}

/**
 * One alert off the SSE stream.
 *
 * An **update** to a row already on screen (a repeat sighting bumping `sightingCount`, or another
 * operator's transition) is applied in place and never reordered, even when the new values would
 * sort it elsewhere. Reordering under the reader is the same failure as inserting under them, and
 * the row is already visible — the next explicit merge or refetch puts it where it belongs.
 *
 * A **new** alert is merged straight in when the queue is idle, and buffered otherwise.
 */
export function receive(
  state: QueueState,
  alert: AlertRecord,
  context: ReceiveContext,
): QueueState {
  const index = state.alerts.findIndex((a) => a.id === alert.id);
  if (index !== -1) {
    const alerts = [...state.alerts];
    alerts[index] = alert;
    return { ...state, alerts };
  }

  const buffered = state.pending.findIndex((a) => a.id === alert.id);
  if (buffered !== -1) {
    const pending = [...state.pending];
    pending[buffered] = alert;
    return { ...state, pending };
  }

  if (context.idle) {
    return { ...state, alerts: sortAlerts([alert, ...state.alerts], context.sort) };
  }
  return { ...state, pending: [alert, ...state.pending] };
}

/** Flush the buffer. The only place a new row may appear above one the operator is reading. */
export function mergePending(state: QueueState, sort: AlertSort): QueueState {
  if (state.pending.length === 0) return state;
  return {
    ...state,
    alerts: sortAlerts([...state.pending, ...state.alerts], sort),
    pending: [],
  };
}

/**
 * A fresh page from the API, after a reconnect or a filter change.
 *
 * D2-06: the stream is a live view, not a durable log, so anything raised while disconnected is in
 * the table and not on the wire. Optimistic transitions still in flight are preserved on top of the
 * server's rows — the server has not seen them yet, and dropping them would flicker a row that the
 * operator has already acted on back to `new`.
 */
export function replace(state: QueueState, alerts: AlertRecord[], sort: AlertSort): QueueState {
  const optimistic = new Set(Object.keys(state.inFlight));
  const merged = alerts.map((server) => {
    if (!optimistic.has(server.id)) return server;
    const local = state.alerts.find((a) => a.id === server.id);
    return local ?? server;
  });
  return {
    ...state,
    alerts: sortAlerts(merged, sort),
    pending: [],
    cursorId: merged.some((a) => a.id === state.cursorId) ? state.cursorId : null,
    expandedId: merged.some((a) => a.id === state.expandedId) ? state.expandedId : null,
  };
}

/* ── transitions ────────────────────────────────────────────────────────────────────────────── */

/**
 * Whether the button is offered at all.
 *
 * Both halves matter and neither is sufficient: `canTransition` is D2-06's lifecycle graph, and
 * `mayAct` is the RBAC answer — `auditor` may read the queue and may not move anything in it, and
 * offering a button that returns 403 teaches an operator to distrust the screen.
 */
export function transitionAllowed(
  alert: AlertRecord,
  to: AlertStatus,
  mayAct: boolean,
): boolean {
  return mayAct && canTransition(alert.status, to);
}

/** Dismiss, and only dismiss, refuses to proceed without a reason. */
export function dismissBlocked(note: string): boolean {
  return note.trim().length === 0;
}

export interface OptimisticResult {
  state: QueueState;
  /** The record as it was, to hand back to `rollbackTransition` if the server refuses. */
  previous: AlertRecord;
}

/**
 * Paint the transition immediately.
 *
 * The row keeps its position: a status change must not move a row the operator is still looking at,
 * and the next refetch re-sorts everything under one explicit gesture instead.
 */
export function applyTransition(
  state: QueueState,
  id: string,
  to: AlertStatus,
  actorId: string,
  at: string = new Date().toISOString(),
): OptimisticResult | null {
  const index = state.alerts.findIndex((a) => a.id === id);
  const previous = state.alerts[index];
  if (index === -1 || previous === undefined) return null;

  const optimistic: AlertRecord = {
    ...previous,
    status: to,
    statusChangedBy: actorId,
    statusChangedAt: at,
    ...(to === 'ack' ? { ackedBy: actorId, ackedAt: at } : {}),
  };
  const alerts = [...state.alerts];
  alerts[index] = optimistic;

  return {
    state: { ...state, alerts, inFlight: { ...state.inFlight, [id]: previous } },
    previous,
  };
}

/** Put it back exactly as it was — same fields, same index. */
export function rollbackTransition(state: QueueState, id: string): QueueState {
  const previous = state.inFlight[id];
  const inFlight = { ...state.inFlight };
  delete inFlight[id];
  if (previous === undefined) return { ...state, inFlight };

  const index = state.alerts.findIndex((a) => a.id === id);
  if (index === -1) return { ...state, inFlight };
  const alerts = [...state.alerts];
  alerts[index] = previous;
  return { ...state, alerts, inFlight };
}

/** The server agreed. Its record wins — it carries the real actor and the real timestamp. */
export function settleTransition(state: QueueState, alert: AlertRecord): QueueState {
  const inFlight = { ...state.inFlight };
  delete inFlight[alert.id];
  const index = state.alerts.findIndex((a) => a.id === alert.id);
  if (index === -1) return { ...state, inFlight };
  const alerts = [...state.alerts];
  alerts[index] = alert;
  return { ...state, alerts, inFlight };
}

/* ── the keyboard cursor ────────────────────────────────────────────────────────────────────── */

/** `j` / `k`. From nothing, `j` takes the first row and `k` the last. Clamped, never wrapping —
 *  wrapping from the bottom to the top of a 500-row queue loses an operator's place. */
export function moveCursor(state: QueueState, delta: number): QueueState {
  if (state.alerts.length === 0) return { ...state, cursorId: null };
  const current = state.alerts.findIndex((a) => a.id === state.cursorId);
  const next =
    current === -1
      ? delta > 0
        ? 0
        : state.alerts.length - 1
      : Math.min(state.alerts.length - 1, Math.max(0, current + delta));
  return { ...state, cursorId: state.alerts[next]?.id ?? null };
}

export function cursorIndex(state: QueueState): number {
  return state.alerts.findIndex((a) => a.id === state.cursorId);
}

/* ── virtualisation ─────────────────────────────────────────────────────────────────────────── */

export interface WindowInput {
  scrollTop: number;
  viewportHeight: number;
  count: number;
  rowHeight: number;
  /** Index of the one expanded row, or `-1`. */
  expandedIndex: number;
  /** Measured height of the expanded detail panel. */
  detailHeight: number;
  overscan?: number;
}

export interface WindowResult {
  start: number;
  /** Exclusive. */
  end: number;
  /** Spacer above the rendered slice. */
  padTop: number;
  /** Spacer below it. */
  padBottom: number;
  totalHeight: number;
}

/**
 * Which rows to actually put in the DOM.
 *
 * Hand-written rather than a dependency: the list has one variable-height row (the expanded one)
 * and everything else is a constant, which is four lines of arithmetic. `package.json` is the
 * repo's most-contended file — six of six D1 tickets touched it — and one list does not justify
 * another entry in it.
 *
 * The expanded row's extra height is added to every offset **after** it, which is what keeps the
 * scroll position stable when a row below the viewport is expanded from the keyboard.
 */
export function windowFor(input: WindowInput): WindowResult {
  const { scrollTop, viewportHeight, count, rowHeight, expandedIndex, detailHeight } = input;
  const overscan = input.overscan ?? 6;
  const extra = expandedIndex >= 0 ? detailHeight : 0;
  const totalHeight = count * rowHeight + extra;

  if (count === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 };

  /** Pixel offset of row `i`, including the expanded panel above it. */
  const offsetOf = (i: number): number =>
    i * rowHeight + (expandedIndex >= 0 && i > expandedIndex ? detailHeight : 0);

  let start = 0;
  while (start < count - 1 && offsetOf(start + 1) <= scrollTop) start += 1;
  start = Math.max(0, start - overscan);

  let end = start;
  const limit = scrollTop + viewportHeight;
  while (end < count && offsetOf(end) < limit) end += 1;
  end = Math.min(count, end + overscan);

  const padTop = offsetOf(start);
  const padBottom = Math.max(0, totalHeight - offsetOf(end));
  return { start, end, padTop, padBottom, totalHeight };
}
