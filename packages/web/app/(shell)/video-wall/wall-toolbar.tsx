'use client';

/**
 * The wall's controls: grid size, overlay, save state, and what the relay is costing the gateway.
 *
 * The relay counter is not developer telemetry that escaped into the UI. The organisers ask clients
 * to pace their load *because each connected client gets its own copy of the stream*, and this is
 * the line that says whether we are honouring that: how many upstream requests nine tiles have
 * actually cost, how many were served from cache instead, and how long the gateway is currently
 * taking to answer. An operator seeing `mean 31,400 ms upstream` learns the estate is throttling,
 * which is a fact about their infrastructure, not about this console.
 */
import { WALL_GRIDS, type WallGrid } from '@/src/lib/wall/layout';
import type { RelayStats } from './types';

export function WallToolbar({
  grid,
  overlay,
  saving,
  saveFailed,
  relay,
  onGrid,
  onOverlay,
}: {
  grid: WallGrid;
  overlay: boolean;
  saving: boolean;
  saveFailed: boolean;
  relay: RelayStats | null;
  onGrid: (grid: WallGrid) => void;
  onOverlay: (overlay: boolean) => void;
}) {
  const cacheRate =
    relay === null || relay.hits + relay.misses === 0
      ? null
      : relay.hits / (relay.hits + relay.misses);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <div
          role="group"
          aria-label="Grid size"
          className="flex overflow-hidden rounded-md border border-slate-700"
        >
          {WALL_GRIDS.map((option) => (
            <button
              key={option}
              type="button"
              data-testid="wall-grid-option"
              data-grid={option}
              aria-pressed={grid === option}
              onClick={() => {
                onGrid(option);
              }}
              className={`px-3 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${
                grid === option
                  ? 'bg-sky-900/60 text-sky-100'
                  : 'bg-slate-900/60 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <label className="flex cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300">
          <input
            type="checkbox"
            data-testid="wall-overlay-toggle"
            checked={overlay}
            onChange={(event) => {
              onOverlay(event.target.checked);
            }}
            className="size-3.5 accent-sky-500"
          />
          Detection overlay
        </label>
      </div>

      <div className="flex items-center gap-3 text-[11px] text-slate-500">
        {relay === null ? null : (
          <span
            data-testid="wall-relay-stats"
            title={
              'Upstream requests this relay has made to the department gateway, and how many tile ' +
              'requests it answered from its own cache instead. A VOD playlist and its segments are ' +
              'immutable by the HLS spec, so caching them is correct — and it is how nine tiles cost ' +
              'the gateway one copy of the stream rather than nine.'
            }
            className="tabular-nums"
          >
            relay · {relay.upstreamRequests} upstream ·{' '}
            {cacheRate === null ? '—' : `${(cacheRate * 100).toFixed(0)}% cached`} ·{' '}
            {relay.meanUpstreamMs.toLocaleString()} ms mean
            {relay.queued > 0 ? ` · ${relay.queued} queued` : ''}
          </span>
        )}
        <span data-testid="wall-save-state">
          {saveFailed ? (
            <span className="text-amber-400">layout not saved</span>
          ) : saving ? (
            'saving…'
          ) : (
            'layout saved'
          )}
        </span>
      </div>
    </div>
  );
}
