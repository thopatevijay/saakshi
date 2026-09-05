/**
 * The wall's debug handle — `window.__saakshiWall`.
 *
 * D1-08 established this pattern for the map (`window.__saakshiMap`, `__saakshiFeatures`,
 * `__saakshiMapIdle`) because *"a WebGL canvas is opaque to every kind of assertion"*. A `<video>`
 * is worse: the pixels are in a compositor layer no script can read, and the interesting facts —
 * **is a connection open, was it closed, how many players have ever been created** — have no DOM
 * representation at all.
 *
 * Three of this ticket's acceptance criteria are about exactly those facts:
 *
 *   - *"Only visible tiles hold connections"* → `openCameraIds`
 *   - *"Unmounting a tile closes its connection (no leaked streams)"* → `created` vs `destroyed`
 *   - *"Browser memory stable over a 10-minute grid session"* → `live` must not climb
 *
 * `created - destroyed === live === openCameraIds.length` is the leak invariant, and
 * `verify-wall.mjs` asserts it after every mount/unmount cycle. A counter that only goes up is how
 * a leak is *proved*, rather than inferred from a memory graph that could be noise.
 */

export interface WallPlayerState {
  cameraId: string;
  externalId: string;
  slot: number;
  transport: 'hls' | 'whep';
  /** `video.readyState`. >= 2 means a frame is decodable. */
  readyState: number;
  currentTime: number;
  /** Playback seconds delivered per second of wall clock. Null until the first fragment. */
  deliveryRate: number | null;
  fragments: number;
  /** Relay cache hits among those fragments, from the `x-saakshi-relay` header. */
  cacheHits: number;
  error: string | null;
}

export interface WallDebug {
  created: number;
  destroyed: number;
  live: number;
  openCameraIds: string[];
  players: Record<string, WallPlayerState>;
  /** Every media request the page has issued, by camera. Cheap; the count is what matters. */
  requests: Record<string, number>;
}

const KEY = '__saakshiWall';

function store(): WallDebug {
  const global = window as unknown as Record<string, WallDebug | undefined>;
  let debug = global[KEY];
  if (debug === undefined) {
    debug = { created: 0, destroyed: 0, live: 0, openCameraIds: [], players: {}, requests: {} };
    global[KEY] = debug;
  }
  return debug;
}

export function wallDebug(): WallDebug | null {
  return typeof window === 'undefined' ? null : store();
}

export function playerOpened(state: WallPlayerState): void {
  const debug = wallDebug();
  if (debug === null) return;
  debug.created += 1;
  debug.live += 1;
  debug.players[state.cameraId] = state;
  debug.openCameraIds = Object.keys(debug.players);
}

export function playerUpdated(cameraId: string, patch: Partial<WallPlayerState>): void {
  const debug = wallDebug();
  if (debug === null) return;
  const existing = debug.players[cameraId];
  if (existing === undefined) return;
  Object.assign(existing, patch);
}

export function playerClosed(cameraId: string): void {
  const debug = wallDebug();
  if (debug === null) return;
  if (debug.players[cameraId] === undefined) return;
  delete debug.players[cameraId];
  debug.destroyed += 1;
  debug.live -= 1;
  debug.openCameraIds = Object.keys(debug.players);
}

export function requestCounted(cameraId: string): void {
  const debug = wallDebug();
  if (debug === null) return;
  debug.requests[cameraId] = (debug.requests[cameraId] ?? 0) + 1;
}
