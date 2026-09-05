/**
 * The HLS relay that stands between a browser and a department's stream gateway.
 *
 * ## Why this exists at all
 *
 * A `<video>` in the console cannot reach the sandbox directly, for three independent reasons, and
 * fixing any two of them still leaves a black tile:
 *
 *   1. **Cross-origin.** The gateway sends no `Access-Control-Allow-Origin`, so `hls.js`'s XHR for
 *      the playlist is blocked before a byte is read.
 *   2. **A session cookie.** Every path — playlist, key *and* every segment — 302s to a login page
 *      without `sentinel=`. A third-party cookie is not something a browser will attach here, and
 *      handing that cookie to client JavaScript would put a government session in the DOM.
 *   3. **AES-128.** `#EXT-X-KEY:URI="/enc.key"` is an absolute path at the gateway root. Even a
 *      permissive CORS policy would leave the key fetch unauthenticated and every segment
 *      undecryptable.
 *
 * So the browser talks to us, and we talk to the gateway. That is the same shape as the edge node
 * in PROJECT.md §2 — video stays where it is, and what crosses the boundary is mediated.
 *
 * ## The cache is correctness, not a shortcut
 *
 * The sandbox serves `#EXT-X-PLAYLIST-TYPE:VOD` with `#EXT-X-ENDLIST`. By RFC 8216 §6.2.1 a VOD
 * playlist is **complete and immutable**, and so is every segment it names. Caching an immutable
 * resource is not staleness risk; re-fetching it is waste. And the waste is not theoretical — this
 * gateway was measured on 2026-09-05 at:
 *
 *   - `index.m3u8`, 216 KB / 14,409 lines / 7,200 segments — **43.1 s**
 *   - `seg00000.ts`, 269 KB — **48.7 s**;  `seg00001.ts`, 209 KB — **21.8 s**
 *   - `enc.key`, 16 B — **13.5 s**
 *
 * A 6.0 s segment delivered in 21.8–48.7 s is **0.12×–0.28× real time**. Without a cache, nine
 * tiles of the same nine cameras mean nine playlist fetches and nine copies of every segment, and
 * the organisers' Integrator's Guide asks clients to pace their load precisely because *"each
 * connected client gets its own copy of the stream"*. With it, a camera costs the gateway one
 * playlist however many operators are watching, and a re-opened tile costs it nothing.
 *
 * `hlsAlwaysRemux`-style live sources are handled too: a playlist without `ENDLIST` is cached for
 * `LIVE_PLAYLIST_TTL_MS` only, because then it genuinely does change.
 *
 * ## What this module refuses to do
 *
 * It never *publishes* to a gateway and never calls a control API — consume only (CLAUDE.md). And
 * it never constructs a stream URL from a hardcoded pattern: `GET /api/ingest` is the contract, the
 * URL shape is configuration, and `resolveUpstream` is the single place that rule lives on this
 * side of the codebase (`workers/prober/run.py:stream_url` is its Python twin).
 */
import { Buffer } from 'node:buffer';

/** The browser-shaped UA the gateway's CDN requires. Mirrors `adapters/ffmpeg.ts`'s `BROWSER_UA`. */
export const RELAY_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** VOD is immutable by the spec, so this is bounded by memory, not by freshness. */
const VOD_PLAYLIST_TTL_MS = 6 * 60 * 60 * 1000;
/** A playlist with no `#EXT-X-ENDLIST` really does change. Just long enough to collapse a burst. */
const LIVE_PLAYLIST_TTL_MS = 2_000;

export interface RelayCamera {
  readonly externalId: string;
  readonly adapterKind: string;
  readonly endpoints: Record<string, string>;
}

export interface RelayConfig {
  /** `SENTINEL_STREAM_TEMPLATE` — `{external_id}` is substituted. Wins over `host`. */
  readonly template?: string | undefined;
  /** `SENTINEL_HOST` — the last resort, and still configuration rather than a constant. */
  readonly host?: string | undefined;
  /** `SENTINEL_PORTAL_COOKIE`. Never logged, never returned to a client. */
  readonly cookie?: string | undefined;
  /** Upstream requests in flight at once, across every camera. Pacing, as the organisers ask. */
  readonly concurrency?: number;
  /** Segment + key + playlist cache ceiling, in bytes. */
  readonly cacheBytes?: number;
  /** Segments fetched ahead of the one just served. 0 disables read-ahead. */
  readonly readAhead?: number;
  /** Injected by tests. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export class RelayConfigurationError extends Error {}
export class RelayUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RelayUpstreamError';
  }
}

// ── URL resolution ──────────────────────────────────────────────────────────────────────────────

/**
 * Where this camera's stream actually is.
 *
 * The registry row wins; then a configured template; then a configured host. There is deliberately
 * no fourth branch: an estate whose URLs look nothing like this one's is a config change, never a
 * code change. Mirrors `workers/prober/run.py:stream_url` exactly, including the fallback order.
 */
export function resolveUpstream(camera: RelayCamera, config: RelayConfig): string {
  const fromRegistry = camera.endpoints[camera.adapterKind] ?? camera.endpoints['hls'];
  if (fromRegistry !== undefined && fromRegistry !== '') return fromRegistry;

  if (config.template !== undefined && config.template !== '') {
    return config.template.replaceAll('{external_id}', camera.externalId);
  }
  if (config.host !== undefined && config.host !== '') {
    return `https://${config.host}/${camera.externalId}/index.m3u8`;
  }
  throw new RelayConfigurationError(
    `no stream URL for ${camera.externalId}: the registry carries no endpoint and neither ` +
      'SENTINEL_STREAM_TEMPLATE nor SENTINEL_HOST is configured',
  );
}

// ── The upstream token ──────────────────────────────────────────────────────────────────────────
//
// Segments and keys are addressed by the *absolute upstream URL*, base64url-encoded into a query
// parameter, rather than by mirroring the gateway's path structure under ours. Mirroring looks
// tidier and is a trap: it silently assumes every gateway lays its segments out under the playlist,
// which is exactly the "the URL pattern is not the contract" mistake in a new hat.

export function encodeUpstreamToken(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url');
}

export function decodeUpstreamToken(token: string): string {
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  if (decoded === '' || encodeUpstreamToken(decoded) !== token) {
    throw new RelayUpstreamError('malformed upstream token', 400);
  }
  return decoded;
}

/**
 * The SSRF guard.
 *
 * A client-supplied URL that the server then fetches is the classic server-side request forgery
 * shape, and "it came from our own playlist" is not a control — the token is in the query string
 * and anyone can write another one. So the decoded target must live on the **same origin as the
 * camera's own upstream**: the relay can reach the gateway that camera is on, and nothing else.
 * That also means a compromised registry row widens the blast radius to one gateway, not to the
 * whole internal network.
 */
export function assertRelayable(candidate: string, cameraUpstream: string): URL {
  let target: URL;
  try {
    target = new URL(candidate);
  } catch {
    throw new RelayUpstreamError('upstream token is not an absolute URL', 400);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new RelayUpstreamError(`refusing to relay ${target.protocol} — http(s) only`, 400);
  }
  const allowed = new URL(cameraUpstream);
  if (target.origin !== allowed.origin) {
    throw new RelayUpstreamError(
      `refusing to relay ${target.origin}: this camera streams from ${allowed.origin}`,
      403,
    );
  }
  return target;
}

// ── Playlist rewriting ──────────────────────────────────────────────────────────────────────────

/** Attributes that carry a URI and therefore have to be rewritten, not only segment lines. */
const URI_ATTRIBUTE_TAGS = ['#EXT-X-KEY', '#EXT-X-MAP', '#EXT-X-SESSION-KEY', '#EXT-X-PART'];

export interface RewrittenPlaylist {
  readonly body: string;
  /** Absolute upstream URLs of the media segments, in playlist order. Drives read-ahead. */
  readonly segments: string[];
  /** True when `#EXT-X-ENDLIST` is present — the playlist is complete and immutable. */
  readonly vod: boolean;
}

/**
 * Rewrite every URI in an HLS media playlist to point back at this relay.
 *
 * Emitted URIs are **relative** (`media?u=…`), so they resolve against whatever path the console
 * serves the playlist from. That keeps the relay mountable at more than one prefix — the browser
 * reaches it at `/video-wall/stream/<id>/index.m3u8` and the API serves it at
 * `/api/v1/streams/<id>/index.m3u8` — without either side knowing the other's routing.
 *
 * A master playlist (`#EXT-X-STREAM-INF`) is handled by the same code path: the URI on the line
 * after the tag is a variant playlist, and rewriting it to `?u=` means the variant is relayed too.
 * `mediaPath` is used for both because the relay does not need to know which it is fetching — it
 * re-reads the content type from upstream.
 */
export function rewritePlaylist(
  body: string,
  upstreamUrl: string,
  mediaPath = 'media',
): RewrittenPlaylist {
  const base = new URL(upstreamUrl);
  const segments: string[] = [];
  let vod = false;

  const proxied = (uri: string): string => {
    const absolute = new URL(uri, base).toString();
    return `${mediaPath}?u=${encodeUpstreamToken(absolute)}`;
  };

  const lines = body.split('\n').map((raw) => {
    const line = raw.replace(/\r$/, '');
    if (line === '') return line;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-ENDLIST')) vod = true;
      const tag = line.slice(0, line.indexOf(':') === -1 ? line.length : line.indexOf(':'));
      if (!URI_ATTRIBUTE_TAGS.includes(tag)) return line;
      // `URI="…"` inside an attribute list. `METHOD=NONE` carries no URI and is left alone.
      return line.replace(/URI="([^"]*)"/g, (whole, uri: string) =>
        uri === '' ? whole : `URI="${proxied(uri)}"`,
      );
    }

    const absolute = new URL(line, base).toString();
    segments.push(absolute);
    return proxied(line);
  });

  return { body: lines.join('\n'), segments, vod };
}

// ── The relay ───────────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly expiresAt: number;
}

export interface RelayFetchResult {
  readonly bytes: Buffer;
  readonly contentType: string;
  /** True when this was served without touching the gateway. */
  readonly cached: boolean;
  /** Wall-clock milliseconds spent upstream. 0 on a cache hit. */
  readonly upstreamMs: number;
}

export interface RelayStats {
  readonly cachedObjects: number;
  readonly cachedBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly upstreamRequests: number;
  readonly inFlight: number;
  readonly queued: number;
  /** Rolling mean of upstream wall time, in ms. The honest answer to "why is the tile stalling". */
  readonly meanUpstreamMs: number;
}

export class StreamRelay {
  private readonly cache = new Map<string, CacheEntry>();
  private cachedBytes = 0;
  private readonly segmentOrder = new Map<string, number>();
  private segments: string[] = [];
  private readonly prefetching = new Set<string>();
  private inFlight = 0;
  private readonly queue: (() => void)[] = [];
  private hits = 0;
  private misses = 0;
  private upstreamRequests = 0;
  private upstreamMsTotal = 0;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly cacheBytes: number;
  private readonly readAhead: number;

  constructor(private readonly config: RelayConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
    this.concurrency = config.concurrency ?? 4;
    this.cacheBytes = config.cacheBytes ?? 256 * 1024 * 1024;
    this.readAhead = config.readAhead ?? 2;
  }

  resolve(camera: RelayCamera): string {
    return resolveUpstream(camera, this.config);
  }

  /**
   * The camera's playlist, rewritten to point back here.
   *
   * The *rewritten* form is what is cached, not the raw upstream body: rewriting 14,409 lines nine
   * times for nine tiles of the same camera is work nobody needs done twice, and the result is a
   * pure function of an immutable input.
   */
  async playlist(camera: RelayCamera, mediaPath = 'media'): Promise<RelayFetchResult> {
    const upstream = this.resolve(camera);
    const key = `playlist:${mediaPath}:${upstream}`;
    const cached = this.readCache(key);
    if (cached !== null) {
      this.hits += 1;
      return { ...cached, cached: true, upstreamMs: 0 };
    }

    this.misses += 1;
    const raw = await this.fetchUpstream(new URL(upstream));
    const rewritten = rewritePlaylist(raw.bytes.toString('utf8'), upstream, mediaPath);
    // Segment order is what read-ahead walks; it is per-camera and replaced on every refetch.
    this.segmentOrder.clear();
    rewritten.segments.forEach((url, index) => this.segmentOrder.set(url, index));
    this.segments = rewritten.segments;

    const bytes = Buffer.from(rewritten.body, 'utf8');
    this.writeCache(key, {
      bytes,
      contentType: 'application/vnd.apple.mpegurl',
      expiresAt: this.now() + (rewritten.vod ? VOD_PLAYLIST_TTL_MS : LIVE_PLAYLIST_TTL_MS),
    });
    return {
      bytes,
      contentType: 'application/vnd.apple.mpegurl',
      cached: false,
      upstreamMs: raw.upstreamMs,
    };
  }

  /**
   * A segment or a decryption key.
   *
   * `signal` is the browser's own abort, propagated upstream: a tile that unmounts mid-segment must
   * stop costing the gateway bandwidth immediately, which is AC 3 seen from the other end of the
   * wire.
   */
  async media(target: URL, signal?: AbortSignal): Promise<RelayFetchResult> {
    const key = `media:${target.toString()}`;
    const cached = this.readCache(key);
    if (cached !== null) {
      this.hits += 1;
      this.scheduleReadAhead(target.toString());
      return { ...cached, cached: true, upstreamMs: 0 };
    }

    this.misses += 1;
    const result = await this.fetchUpstream(target, signal);
    this.writeCache(key, {
      bytes: result.bytes,
      contentType: result.contentType,
      // Segments under a VOD playlist are immutable; a live one re-names them, so this is safe.
      expiresAt: this.now() + VOD_PLAYLIST_TTL_MS,
    });
    this.scheduleReadAhead(target.toString());
    return result;
  }

  stats(): RelayStats {
    return {
      cachedObjects: this.cache.size,
      cachedBytes: this.cachedBytes,
      hits: this.hits,
      misses: this.misses,
      upstreamRequests: this.upstreamRequests,
      inFlight: this.inFlight,
      queued: this.queue.length,
      meanUpstreamMs:
        this.upstreamRequests === 0
          ? 0
          : Math.round(this.upstreamMsTotal / this.upstreamRequests),
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────

  private readCache(key: string): { bytes: Buffer; contentType: string } | null {
    const entry = this.cache.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      this.cachedBytes -= entry.bytes.byteLength;
      return null;
    }
    // Re-insert so iteration order is least-recently-used first.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return { bytes: entry.bytes, contentType: entry.contentType };
  }

  private writeCache(key: string, entry: CacheEntry): void {
    if (entry.bytes.byteLength > this.cacheBytes) return;
    const existing = this.cache.get(key);
    if (existing !== undefined) this.cachedBytes -= existing.bytes.byteLength;
    this.cache.set(key, entry);
    this.cachedBytes += entry.bytes.byteLength;

    while (this.cachedBytes > this.cacheBytes) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      const victim = this.cache.get(oldest.value);
      this.cache.delete(oldest.value);
      if (victim !== undefined) this.cachedBytes -= victim.bytes.byteLength;
    }
  }

  /**
   * Fetch the next few segments while the player chews on this one.
   *
   * At 0.12×–0.28× real time a strictly on-demand relay can never catch up: the player asks for a
   * segment, waits 20–50 s, plays 6 s, and asks again. Reading ahead pipelines that wait instead of
   * serialising it.
   *
   * **Opportunistic, never queued.** The first version of this shared the concurrency queue with
   * real requests, and on a nine-tile wall that is a stampede: every served segment schedules three
   * speculative fetches, so twenty-seven prefetches sit in front of the segment a player is
   * actually waiting for, on a gateway taking ~15 s per request. The queue never drained and the
   * wall went backwards. So a prefetch is issued **only when there is spare capacity right now** —
   * nothing is queued behind it, and a guess never delays a certainty.
   *
   * Failures are swallowed on purpose: a prefetch that fails costs nothing, because the real
   * request will surface the error.
   */
  private scheduleReadAhead(justServed: string): void {
    if (this.readAhead <= 0) return;
    if (this.queue.length > 0 || this.inFlight >= this.concurrency) return;
    const index = this.segmentOrder.get(justServed);
    if (index === undefined) return;

    for (let i = index + 1; i <= index + this.readAhead && i < this.segments.length; i += 1) {
      const url = this.segments[i];
      if (url === undefined) continue;
      const key = `media:${url}`;
      if (this.cache.has(key) || this.prefetching.has(key)) continue;
      if (this.queue.length > 0 || this.inFlight >= this.concurrency) return;
      this.prefetching.add(key);
      void this.fetchUpstream(new URL(url))
        .then((result) => {
          this.writeCache(key, {
            bytes: result.bytes,
            contentType: result.contentType,
            expiresAt: this.now() + VOD_PLAYLIST_TTL_MS,
          });
        })
        .catch(() => undefined)
        .finally(() => this.prefetching.delete(key));
    }
  }

  /** One upstream request, through the concurrency gate. */
  private async fetchUpstream(target: URL, signal?: AbortSignal): Promise<RelayFetchResult> {
    await this.acquire();
    const started = this.now();
    try {
      const headers: Record<string, string> = { 'user-agent': RELAY_UA };
      // The government session cookie. It never leaves this process in either direction: it is not
      // echoed to the client and it is not logged.
      if (this.config.cookie !== undefined && this.config.cookie !== '') {
        headers['cookie'] = this.config.cookie;
      }

      const response = await this.fetchImpl(target.toString(), {
        headers,
        redirect: 'follow',
        ...(signal === undefined ? {} : { signal }),
      });

      if (!response.ok) {
        // Always 502, never the upstream's own status. A 401 from the gateway means *our* session
        // cookie expired, not that this operator is unauthorised — surfacing it as 401 would log
        // them out of SAAKSHI because a government cookie went stale, which is D1-03's
        // "an expired session cookie reported as 'camera down'" mistake with the arrow reversed.
        throw new RelayUpstreamError(
          `upstream responded ${String(response.status)} for ${target.pathname}`,
          502,
        );
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      const upstreamMs = this.now() - started;
      this.upstreamRequests += 1;
      this.upstreamMsTotal += upstreamMs;

      return {
        bytes,
        // The sandbox labels `.ts` segments `text/vnd.trolltech.linguist; charset=utf-8` — a
        // TypeScript/Qt Linguist mix-up in somebody's mime table. `hls.js` reads segments as
        // ArrayBuffer and never consults the header, but anything that *does* would choke, so the
        // relay corrects it rather than passing the mislabel on.
        contentType: contentTypeFor(target, response.headers.get('content-type')),
        cached: false,
        upstreamMs,
      };
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.inFlight += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.queue.shift();
    if (next !== undefined) next();
  }
}

/** Trust the extension over a gateway's mime table — see the note in `fetchUpstream`. */
export function contentTypeFor(target: URL, declared: string | null): string {
  const path = target.pathname.toLowerCase();
  if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (path.endsWith('.ts')) return 'video/mp2t';
  if (path.endsWith('.m4s') || path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.aac')) return 'audio/aac';
  if (path.endsWith('.key')) return 'application/octet-stream';
  return declared ?? 'application/octet-stream';
}
