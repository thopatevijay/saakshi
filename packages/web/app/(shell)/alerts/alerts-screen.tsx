'use client';

/**
 * The alert queue — the screen a constable stares at for a shift, and the screen a judge judges.
 *
 * Five decisions here are the acceptance criteria rather than taste:
 *
 * **1 · The live stream comes through a same-origin proxy** (`stream/route.ts`), so no bearer token
 * ever reaches browser JavaScript. `EventSource` cannot send a header, and D2-06 accepts
 * `?access_token=` for that reason — but D1-07 put the token in an httpOnly cookie so that an XSS
 * in any dependency cannot read it, and this screen is not the place to undo that.
 *
 * **2 · An arriving alert is buffered while anybody is working the queue.** `queue.ts` holds the
 * rule and the tests; the visible half is the pill above the list. An alert inserting itself above
 * the row an operator is about to dismiss does not annoy them, it makes them dismiss the wrong
 * alert.
 *
 * **3 · On reconnect the list is refetched.** D2-06: the stream is a live view, not a durable log.
 * Anything raised while the connection was down is in the table and never on the wire, so a screen
 * that only listened would look healthy and be wrong.
 *
 * **4 · Transitions are optimistic with rollback, and a 409 is routine.** Another operator may have
 * moved the alert since this queue rendered it.
 *
 * **5 · The claims banner is above the queue, not under it.** `live: false`, the mock-provider
 * disclaimer, and the measured composition of the queue — five exact matches on OCR fragments, two
 * fuzzy possibilities, nothing higher than medium. A screenshot of this screen has to carry that.
 *
 * The URL is the screen state and is rewritten with `history.replaceState`, not `router.push`:
 * D1-08's reason — a filter change must not re-run a server component and rebuild the whole list.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
} from 'react';
import type { AlertDigest, AlertRecord, AlertStatus } from '@saakshi/shared';
import { EmptyState, ErrorState, Spinner } from '@/src/components/states';
import { useToast } from '@/src/components/toast';
import { alertsHref, parseAlertQuery, type AlertQueryState } from '@/src/lib/alerts/query';
import {
  applyTransition,
  cursorIndex,
  emptyQueue,
  mergePending,
  moveCursor,
  receive,
  replace,
  rollbackTransition,
  settleTransition,
  windowFor,
  type QueueState,
} from '@/src/lib/alerts/queue';
import { AlertDetail } from './alert-detail';
import { AlertFilters } from './alert-filters';
import { AlertRow, ROW_HEIGHT } from './alert-row';
import { DigestBanner } from './digest-banner';
import { loadAlerts, transition } from './actions';
import type { FilterOptions } from './types';

/** The scrolling viewport. Fixed so the virtualiser has a stable height to reason about. */
const VIEWPORT_HEIGHT = 620;
const DEFAULT_DETAIL_HEIGHT = 460;

export interface AlertsScreenProps {
  initialQuery: AlertQueryState;
  initialAlerts: AlertRecord[];
  initialCursor: string | null;
  initialError: string | null;
  disclaimer: string;
  options: FilterOptions;
  /** `alerts:acknowledge` — an auditor may read this queue and may not move anything in it. */
  mayAct: boolean;
  /** `trace:run` — also not an auditor capability. */
  mayTrace: boolean;
  actorId: string;
}

type StreamStatus = 'connecting' | 'live' | 'retrying' | 'fatal';

export function AlertsScreen({
  initialQuery,
  initialAlerts,
  initialCursor,
  initialError,
  disclaimer,
  options,
  mayAct,
  mayTrace,
  actorId,
}: AlertsScreenProps) {
  const { notify } = useToast();
  const [query, setQuery] = useState<AlertQueryState>(initialQuery);
  const [queue, setQueue] = useState<QueueState>(() => emptyQueue(initialAlerts));
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [error, setError] = useState<string | null>(initialError);
  const [digests, setDigests] = useState<AlertDigest[]>([]);
  const [stream, setStream] = useState<StreamStatus>('connecting');
  const [streamNote, setStreamNote] = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingFetch, startFetch] = useTransition();

  const [scrollTop, setScrollTop] = useState(0);
  const [detailHeight, setDetailHeight] = useState(DEFAULT_DETAIL_HEIGHT);
  const viewport = useRef<HTMLDivElement | null>(null);
  const detail = useRef<HTMLDivElement | null>(null);
  const first = useRef(true);

  /**
   * The live state the SSE handler needs, without re-subscribing on every keystroke.
   *
   * A stream that tore down and reopened whenever the cursor moved would drop alerts in the gap and
   * would climb the API's `streamSubscribers` counter. So the effect depends on nothing that
   * changes during use, and reads the volatile parts through a ref.
   */
  const live = useRef({ sort: query.sort, idle: true });
  live.current = {
    sort: query.sort,
    idle: queue.cursorId === null && scrollTop < ROW_HEIGHT,
  };

  /* ── the URL is the screen ──────────────────────────────────────────────────────────────── */

  useEffect(() => {
    window.history.replaceState(null, '', alertsHref(query));
  }, [query]);

  /** The back button must actually go back to the previous filter set. */
  useEffect(() => {
    const onPop = (): void => {
      setQuery(parseAlertQuery(new URLSearchParams(window.location.search)));
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  const refetch = useCallback((next: AlertQueryState) => {
    startFetch(async () => {
      const page = await loadAlerts(next);
      setError(page.error);
      setCursor(page.nextCursor);
      setQueue((current) => replace(current, page.alerts, next.sort));
      setScrollTop(0);
      if (viewport.current !== null) viewport.current.scrollTop = 0;
    });
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    refetch(query);
  }, [query, refetch]);

  /**
   * A stable handle for "reload the queue as it is filtered right now".
   *
   * The stream effect and the 409 path both need it, and neither may depend on `query` — the stream
   * must be opened exactly once for the life of the screen, and re-subscribing on a filter change
   * would drop every alert that arrived during the gap.
   */
  const refetchRef = useRef<() => void>(() => undefined);
  refetchRef.current = () => {
    refetch(query);
  };

  /* ── the live stream ────────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    const source = new EventSource('/alerts/stream');

    source.addEventListener('ready', () => {
      setStream('live');
      setStreamNote(null);
    });

    source.addEventListener('alert', (event) => {
      const alert = JSON.parse((event as MessageEvent<string>).data) as AlertRecord;
      setQueue((current) => receive(current, alert, live.current));
    });

    source.addEventListener('digest', (event) => {
      const digest = JSON.parse((event as MessageEvent<string>).data) as AlertDigest;
      setDigests((current) => [digest, ...current].slice(0, 3));
    });

    // `fatal` is the proxy's way of reporting an auth or upstream failure: EventSource retries a
    // failed *connection* forever and gives the page no way to read a status code, so the proxy
    // answers 200 with one frame that says what went wrong.
    source.addEventListener('fatal', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { message: string };
      setStream('fatal');
      setStreamNote(payload.message);
      source.close();
    });

    source.onerror = () => {
      // The browser reconnects on its own (`retry: 3000`). The queue refetches when it comes back
      // — the stream is a live view, not a durable log, and the gap is in the table.
      setStream((current) => (current === 'fatal' ? current : 'retrying'));
    };

    source.onopen = () => {
      setStream((current) => {
        if (current === 'retrying') refetchRef.current();
        return 'live';
      });
    };

    return () => {
      source.close();
    };
    // Opened once for the life of the screen, deliberately. Filters are applied to the *table*, not
    // to the wire: the stream carries everything, and re-subscribing on a filter change would drop
    // every alert raised during the gap. Volatile state reaches the handlers through refs.
  }, []);

  /* ── measuring the expanded panel, so virtualisation stays exact ────────────────────────── */

  useEffect(() => {
    const node = detail.current;
    if (node === null) {
      setDetailHeight(DEFAULT_DETAIL_HEIGHT);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height !== undefined && height > 0) setDetailHeight(height);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [queue.expandedId]);

  /* ── transitions ────────────────────────────────────────────────────────────────────────── */

  const act = useCallback(
    (id: string, to: AlertStatus, note?: string) => {
      if (to !== 'ack' && to !== 'dismissed' && to !== 'escalated') return;
      setBusyId(id);
      setDismissingId(null);

      setQueue((current) => applyTransition(current, id, to, actorId)?.state ?? current);

      void (async () => {
        const result = await transition(id, to, note);
        setBusyId(null);
        if (result.ok) {
          setQueue((current) => settleTransition(current, result.alert));
          notify(
            to === 'ack' ? 'Acknowledged' : to === 'dismissed' ? 'Dismissed' : 'Escalated',
            'success',
          );
          return;
        }
        setQueue((current) => rollbackTransition(current, id));
        notify(result.message, result.kind === 'conflict' ? 'info' : 'error');
        // A 409 means the server's record is newer than ours. Refetching is the only way to show
        // what the other operator actually did.
        if (result.kind === 'conflict') refetchRef.current();
      })();
    },
    [actorId, notify],
  );

  /* ── the keyboard ───────────────────────────────────────────────────────────────────────── */

  const scrollCursorIntoView = useCallback((index: number) => {
    const node = viewport.current;
    if (node === null || index < 0) return;
    const top = index * ROW_HEIGHT;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + ROW_HEIGHT > node.scrollTop + node.clientHeight) {
      node.scrollTop = top + ROW_HEIGHT - node.clientHeight;
    }
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const key = event.key;
      const current = queue.cursorId;

      if (key === 'j' || key === 'ArrowDown' || key === 'k' || key === 'ArrowUp') {
        event.preventDefault();
        const delta = key === 'j' || key === 'ArrowDown' ? 1 : -1;
        setQueue((state) => {
          const next = moveCursor(state, delta);
          scrollCursorIntoView(cursorIndex(next));
          return next;
        });
        return;
      }

      if (current === null) return;
      const alert = queue.alerts.find((a) => a.id === current);
      if (alert === undefined) return;

      if (key === 'Enter') {
        event.preventDefault();
        setQueue((state) => ({
          ...state,
          expandedId: state.expandedId === current ? null : current,
        }));
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        if (dismissingId !== null) setDismissingId(null);
        else setQueue((state) => ({ ...state, expandedId: null }));
        return;
      }
      if (!mayAct) return;
      if (key === 'a') {
        event.preventDefault();
        act(current, 'ack');
        return;
      }
      if (key === 'e') {
        event.preventDefault();
        act(current, 'escalated');
        return;
      }
      if (key === 'd') {
        // Never a one-key dismissal: `d` opens the reason field, and the field takes the next keys.
        event.preventDefault();
        setDismissingId(current);
      }
    },
    [act, dismissingId, mayAct, queue.alerts, queue.cursorId, scrollCursorIntoView],
  );

  /** Focus follows the cursor, so the browser's own focus ring is the visible indicator. */
  useEffect(() => {
    if (queue.cursorId === null) return;
    const node = viewport.current?.querySelector<HTMLElement>(
      `[data-alert-id="${queue.cursorId}"]`,
    );
    if (node !== null && node !== undefined && document.activeElement !== node) node.focus();
  }, [queue.cursorId]);

  /* ── the window ─────────────────────────────────────────────────────────────────────────── */

  const expandedIndex = useMemo(
    () => queue.alerts.findIndex((a) => a.id === queue.expandedId),
    [queue.alerts, queue.expandedId],
  );

  const win = windowFor({
    scrollTop,
    viewportHeight: VIEWPORT_HEIGHT,
    count: queue.alerts.length,
    rowHeight: ROW_HEIGHT,
    expandedIndex,
    detailHeight,
  });
  const slice = queue.alerts.slice(win.start, win.end);

  const composition = useMemo(() => {
    const exact = queue.alerts.filter((a) => a.matchType === 'exact').length;
    const fuzzy = queue.alerts.length - exact;
    const bySeverity = queue.alerts.reduce<Record<string, number>>((acc, a) => {
      acc[a.severity] = (acc[a.severity] ?? 0) + 1;
      return acc;
    }, {});
    return { exact, fuzzy, bySeverity };
  }, [queue.alerts]);

  const loadMore = (): void => {
    if (cursor === null) return;
    startFetch(async () => {
      const page = await loadAlerts(query, cursor);
      setCursor(page.nextCursor);
      setQueue((current) => replace(current, [...current.alerts, ...page.alerts], query.sort));
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">Alert queue</h1>
        <p className="flex items-center gap-2 text-xs text-slate-500">
          <span
            data-testid="stream-status"
            data-state={stream}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
              stream === 'live'
                ? 'border-emerald-800 text-emerald-300'
                : stream === 'fatal'
                  ? 'border-rose-800 text-rose-300'
                  : 'border-amber-800 text-amber-300'
            }`}
          >
            <span
              aria-hidden="true"
              className={`size-1.5 rounded-full ${
                stream === 'live'
                  ? 'bg-emerald-400'
                  : stream === 'fatal'
                    ? 'bg-rose-400'
                    : 'animate-pulse bg-amber-400'
              }`}
            />
            {stream === 'live'
              ? 'Live'
              : stream === 'fatal'
                ? 'Stream stopped'
                : stream === 'retrying'
                  ? 'Reconnecting'
                  : 'Connecting'}
          </span>
          {pendingFetch ? <Spinner label="Refreshing" /> : null}
        </p>
      </div>

      {/* ── the claims banner, above the queue where a screenshot will catch it ───────────── */}
      <section
        data-testid="alert-claims"
        className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-4 py-3"
      >
        <p className="text-[11px] leading-relaxed text-amber-100/90">
          <span className="font-semibold">{disclaimer}</span>
        </p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-100/70">
          This queue holds{' '}
          <span className="font-semibold text-amber-100">{queue.alerts.length}</span> alerts —{' '}
          {composition.exact} exact and {composition.fuzzy} fuzzy
          {Object.keys(composition.bySeverity).length === 0
            ? ''
            : ` (${Object.entries(composition.bySeverity)
                .map(([severity, n]) => `${String(n)} ${severity}`)
                .join(', ')})`}
          . An <span className="font-semibold">exact</span> match means the read string equals a
          watchlist string — on this estate those strings are usually OCR fragments, not
          registrations, and the record’s own provenance note says so. A{' '}
          <span className="font-semibold">fuzzy</span> match is a ranked possibility, never an
          identification. Expand any row for the full reasoning.
        </p>
      </section>

      <AlertFilters query={query} options={options} onChange={setQuery} />

      {streamNote === null ? null : (
        <p
          data-testid="stream-note"
          role="status"
          className="rounded-md border border-rose-900/60 bg-rose-950/30 px-4 py-2 text-xs text-rose-200"
        >
          {streamNote}
        </p>
      )}

      {/* ── the unobtrusive new-alert indicator: no layout jump, no modal ─────────────────── */}
      <div className="h-8">
        {queue.pending.length === 0 ? null : (
          <button
            type="button"
            data-testid="new-alerts-pill"
            onClick={() => {
              setQueue((current) => mergePending(current, query.sort));
              if (viewport.current !== null) viewport.current.scrollTop = 0;
            }}
            className="w-full rounded-md border border-sky-700 bg-sky-950/60 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-900/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            {queue.pending.length} new alert{queue.pending.length === 1 ? '' : 's'} — show
          </button>
        )}
      </div>

      {digests.map((digest) => (
        <DigestBanner key={digest.id} digest={digest} />
      ))}

      {error === null ? null : <ErrorState description={error} />}

      {queue.alerts.length === 0 && error === null ? (
        <EmptyState
          title="No alerts match this filter"
          description="The estate raises an alert only when a plate read matches the watchlist. On the measured feed that is rare, and an empty queue is a finding rather than a fault — clear the filters to see everything the engine has raised."
        />
      ) : (
        <>
          {/* Keyboard help, visible rather than hidden behind a `?` nobody presses. */}
          <p className="text-[11px] text-slate-500">
            <kbd className="rounded border border-slate-700 px-1">j</kbd>/
            <kbd className="rounded border border-slate-700 px-1">k</kbd> move ·{' '}
            <kbd className="rounded border border-slate-700 px-1">a</kbd> acknowledge ·{' '}
            <kbd className="rounded border border-slate-700 px-1">d</kbd> dismiss (asks why) ·{' '}
            <kbd className="rounded border border-slate-700 px-1">e</kbd> escalate ·{' '}
            <kbd className="rounded border border-slate-700 px-1">↵</kbd> evidence ·{' '}
            <kbd className="rounded border border-slate-700 px-1">esc</kbd> close
            {mayAct ? '' : ' — this role may read the queue but not action it'}
          </p>

          <div
            ref={viewport}
            data-testid="alert-viewport"
            onScroll={(event) => {
              setScrollTop(event.currentTarget.scrollTop);
            }}
            style={{ height: `${String(VIEWPORT_HEIGHT)}px` }}
            className="overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/30"
          >
            <div style={{ height: `${String(win.totalHeight)}px` }} className="relative">
              <div style={{ height: `${String(win.padTop)}px` }} aria-hidden="true" />
              <div role="list" aria-label="Alerts">
                {slice.map((alert) => (
                  <div key={alert.id}>
                    <AlertRow
                      alert={alert}
                      focused={queue.cursorId === alert.id}
                      expanded={queue.expandedId === alert.id}
                      mayAct={mayAct}
                      busy={busyId === alert.id}
                      dismissing={dismissingId === alert.id}
                      onDismissOpen={(open) => {
                        setDismissingId(open ? alert.id : null);
                      }}
                      onFocusRow={() => {
                        setQueue((current) => ({ ...current, cursorId: alert.id }));
                      }}
                      onToggleExpand={() => {
                        setQueue((current) => ({
                          ...current,
                          cursorId: alert.id,
                          expandedId: current.expandedId === alert.id ? null : alert.id,
                        }));
                      }}
                      onTransition={(to, note) => {
                        act(alert.id, to, note);
                      }}
                      onKeyDown={onKeyDown}
                    />
                    {queue.expandedId === alert.id ? (
                      <div ref={detail}>
                        <AlertDetail
                          alert={alert}
                          mayTrace={mayTrace}
                          onRefreshed={(fresh) => {
                            setQueue((current) =>
                              receive(current, fresh, { sort: query.sort, idle: false }),
                            );
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
              <div style={{ height: `${String(win.padBottom)}px` }} aria-hidden="true" />
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span data-testid="alert-count">
              {queue.alerts.length} alert{queue.alerts.length === 1 ? '' : 's'} ·{' '}
              {win.end - win.start} rendered
            </span>
            {cursor === null ? (
              <span>end of queue</span>
            ) : (
              <button
                type="button"
                onClick={loadMore}
                disabled={pendingFetch}
                className="rounded-md border border-slate-700 px-3 py-1 text-slate-300 hover:bg-slate-800 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              >
                Load more
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
