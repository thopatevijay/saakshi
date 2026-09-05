/**
 * The road graph, behind one small interface (D3-01).
 *
 * OSRM answers a question route reconstruction cannot answer for itself: *given two camera
 * positions, what is the most plausible driving path between them and how long should it take?*
 * That expected duration is the yardstick every inference in `services/route.ts` is scored against,
 * and D3-02 inverts the same number to call a transition impossible.
 *
 * ## Three deliberate choices
 *
 * **1 · Absence is an answer, never an exception.** A machine with no `data/gujarat-latest.osrm`
 * has no road graph, and that is the state of every fresh clone — `data/` is gitignored. So a
 * failed query returns `null` and the segment above it renders as `inferred_unroutable` with a
 * reason, rather than throwing and taking the whole trace with it. A police tool that returns
 * nothing because one subsystem is cold is worse than one that returns the sightings and says the
 * road graph is unavailable.
 *
 * **2 · Alternatives are requested, because path uniqueness is part of the claim.** If OSRM offers
 * a second route within a few per cent of the first, the line drawn on the map is one of several
 * equally good stories and the confidence must say so. `alternatives=3` costs one request, not
 * four, and `alternativeSpread` is the ratio of the best alternative's duration to the chosen
 * one's — 1.0 means "there is another way that is just as quick", large means "there is only one
 * sensible way to get there".
 *
 * **3 · A short timeout, and it is not retried.** A trace is an interactive query with a 3-second
 * budget for 20 sightings. An OSRM instance that has not answered in two seconds is not going to
 * rescue the request; it is going to spend the budget. The failure is recorded and the segment says
 * so.
 *
 * ## What OSRM's numbers mean, precisely
 *
 * `distance` is the length of the **fastest** path, not of the path the vehicle took. It is
 * therefore a **lower bound on the distance driven** — a vehicle that detoured drove further, never
 * less. `duration` is free-flow: OSRM's car profile applies per-class speeds with no traffic model,
 * so real journeys are routinely *slower* and only suspiciously ever faster. Both facts are baked
 * into the asymmetric scoring in `services/route.ts`, and neither is a defect to be corrected here.
 */

/** `[lon, lat]`, GeoJSON order. The order every coordinate in this codebase is in. */
export type LngLat = readonly [number, number];

export interface OsrmRoute {
  /** Metres along the fastest path. A LOWER bound on the distance actually driven. */
  distanceM: number;
  /** Seconds, free-flow. Real journeys are routinely slower and rarely faster. */
  durationS: number;
  /** The path itself, GeoJSON. `null` when the caller asked for no geometry. */
  geometry: { type: 'LineString'; coordinates: [number, number][] } | null;
  /** How many routes OSRM returned in total, the chosen one included. 1 = essentially forced. */
  options: number;
  /**
   * `bestAlternativeDuration / chosenDuration`, or `null` when there is no alternative.
   * 1.0 means a second way is exactly as quick; 1.4 means every other way is 40 % slower.
   */
  alternativeSpread: number | null;
}

export interface OsrmClient {
  /** `null` when the graph has no path, or when OSRM is unreachable. Never throws. */
  route(from: LngLat, to: LngLat): Promise<OsrmRoute | null>;
  /** For the payload's provenance line: which server answered, and whether it is answering. */
  readonly baseUrl: string;
}

interface OsrmResponse {
  code?: string;
  routes?: {
    distance?: number;
    duration?: number;
    geometry?: { type?: string; coordinates?: [number, number][] };
  }[];
}

export interface HttpOsrmOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** `false` skips `geometries=geojson`, which is most of the response size. */
  geometry?: boolean;
}

export const OSRM_DEFAULT_URL = 'http://localhost:5000';
const DEFAULT_TIMEOUT_MS = 2000;

export class HttpOsrmClient implements OsrmClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly geometry: boolean;

  constructor(options: HttpOsrmOptions = {}) {
    this.baseUrl = (options.baseUrl ?? OSRM_DEFAULT_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.geometry = options.geometry ?? true;
  }

  async route(from: LngLat, to: LngLat): Promise<OsrmRoute | null> {
    const coords = `${fmt(from)};${fmt(to)}`;
    const params = new URLSearchParams({
      // Three is enough to tell "forced" from "one of several"; more is paid for and not used.
      alternatives: '3',
      overview: this.geometry ? 'simplified' : 'false',
      geometries: 'geojson',
    });
    const url = `${this.baseUrl}/route/v1/driving/${coords}?${params.toString()}`;

    const body = await this.get(url);
    if (body === null) return null;
    if (body.code !== undefined && body.code !== 'Ok') return null;

    const routes = body.routes ?? [];
    const chosen = routes[0];
    if (chosen === undefined) return null;

    const durationS = numberOr(chosen.duration, null);
    const distanceM = numberOr(chosen.distance, null);
    if (durationS === null || distanceM === null) return null;

    // The best alternative is the cheapest of the rest — OSRM orders by weight, but the ordering
    // is over its internal weight rather than duration, so take the minimum explicitly.
    const alternatives = routes
      .slice(1)
      .map((r) => numberOr(r.duration, null))
      .filter((d): d is number => d !== null && d > 0);
    const bestAlternative = alternatives.length === 0 ? null : Math.min(...alternatives);

    const coordinates = chosen.geometry?.coordinates;
    return {
      distanceM,
      durationS,
      geometry:
        this.geometry && Array.isArray(coordinates) && coordinates.length >= 2
          ? { type: 'LineString', coordinates }
          : null,
      options: routes.length,
      alternativeSpread:
        bestAlternative === null || durationS <= 0 ? null : bestAlternative / durationS,
    };
  }

  private async get(url: string): Promise<OsrmResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) return null;
      return (await response.json()) as OsrmResponse;
    } catch {
      // Unreachable, refused, timed out, or served something that is not JSON. All the same
      // answer to the caller: no road graph right now. The segment says so; the trace still works.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The client for a deployment with no road graph. Not a test double — it is the honest behaviour
 * when `OSRM_URL` is unset, and it is what keeps `reconstruct=true` from being an error on a laptop
 * that has never run `scripts/import-osm.sh`.
 */
export class NullOsrmClient implements OsrmClient {
  readonly baseUrl = '';
  route(): Promise<OsrmRoute | null> {
    return Promise.resolve(null);
  }
}

/** Six decimals is ~0.11 m at the equator — well past what a camera position is known to. */
function fmt(point: LngLat): string {
  return `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
