/**
 * A registry of long-lived connections, so they can be closed *before* React unmounts their page.
 *
 * ## Why this exists — a scheduling deadlock, not a leaky teardown
 *
 * `use-hls-player` already tears down correctly on unmount. The problem is *when* React runs that
 * cleanup. In the App Router the outgoing page unmounts only **after** the router commits the
 * incoming route, which produces a circular wait on a throttled feed:
 *
 *     router waits on its RSC fetch
 *        └─ that fetch queues behind in-flight HLS segment requests
 *           (same origin, ~6 sockets per host on HTTP/1.1)
 *             └─ those requests abort only on unmount
 *                  └─ unmount happens only once the router commits
 *
 * It unwinds eventually — a fragment completes on its own and frees a socket — but "eventually" was
 * **measured at 20.6–21.1 s** leaving a wall of 11 tiles, during which the tab is unresponsive.
 * `fragLoadingTimeOut` is deliberately 120 s so the player does not fight its own relay, which is
 * correct for playback and exactly what makes the stall so long.
 *
 * So the sockets are released on navigation **intent** instead: a capture-phase click handler runs
 * before the router's own, closes every player synchronously, and the RSC fetch then finds a free
 * socket immediately.
 *
 * ## Why a module-level registry rather than context
 *
 * The closer must be callable from a DOM event handler that is deliberately *outside* React's
 * lifecycle — the whole point is to act before React schedules anything. A module-level `Set` is the
 * smallest thing that works from there, and it keeps the player hook unaware of navigation entirely:
 * the hook publishes "here is how to close me", and something else decides when.
 */

/** Closers for every live connection — HLS players on the wall, the SSE stream on the alert queue. */
const closers = new Set<() => void>();

/**
 * Register a player's teardown. Returns the deregister function, so the caller can drop itself on
 * unmount — otherwise a closed player would be closed a second time on the next navigation.
 */
export function registerConnectionCloser(close: () => void): () => void {
  closers.add(close);
  return () => {
    closers.delete(close);
  };
}

/**
 * Close every registered connection, synchronously.
 *
 * Idempotent by construction: the set is drained before the closers run, so a closer that itself
 * deregisters (which `use-hls-player`'s does, via its effect cleanup) cannot mutate what is being
 * iterated, and a second call finds nothing to do. One throwing closer must not prevent the rest
 * from running — a half-released connection pool is the bug this function exists to prevent.
 */
export function closeAllConnections(): number {
  const pending = [...closers];
  closers.clear();
  let closed = 0;
  for (const close of pending) {
    try {
      close();
      closed += 1;
    } catch {
      // A player that fails to close is not a reason to strand the others.
    }
  }
  return closed;
}

/** How many connections are currently registered. Exported for tests and the debug surface. */
export function openConnectionCount(): number {
  return closers.size;
}

/**
 * True when a click should release this section's connections — i.e. a plain left-click on a
 * same-origin link leading somewhere outside `sectionPath`.
 *
 * Everything excluded here is excluded for a reason:
 *   - modified clicks and non-left buttons open a new tab, so this page keeps playing
 *   - `target="_blank"` likewise
 *   - a link inside the section itself is a tile swap, a filter change or a sub-view, and
 *     closing everything for that would make the page tear itself down as you use it
 *   - `download`, other origins, and non-`/` hrefs are not client-side navigations at all
 */
export function isLeavingSection(event: MouseEvent, sectionPath: string): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;

  const target = event.target;
  if (!(target instanceof Element)) return false;
  const anchor = target.closest('a');
  if (anchor === null) return false;
  if (anchor.hasAttribute('download')) return false;
  if (anchor.target !== '' && anchor.target !== '_self') return false;

  const href = anchor.getAttribute('href');
  if (href === null || !href.startsWith('/')) return false;

  const path = href.split('?')[0]?.split('#')[0] ?? '';
  if (path === sectionPath || path.startsWith(`${sectionPath}/`)) return false;

  return true;
}
