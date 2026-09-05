/**
 * The wall's one same-origin hop.
 *
 * ## Why the browser does not talk to the API directly
 *
 * D1-07 put the bearer token in an **httpOnly** cookie so that an XSS in any dependency cannot read
 * it. `hls.js` can set request headers via `xhrSetup`, so it *could* carry a bearer — but only if
 * client JavaScript were handed the token, which undoes that decision for the sake of a video tile
 * and puts a government session into the network panel and into any error reporter that captures
 * request URLs. D2-06 hit the identical problem with `EventSource` and answered it the same way
 * (`app/(shell)/alerts/stream/route.ts`); this is that pattern, for media.
 *
 * So the browser asks *us*, on our own origin, with no credentials in JavaScript at all. This
 * handler reads the cookie on the server and forwards with a proper `Authorization` header.
 *
 * ## Why it is a whitelist and not a pass-through
 *
 * A catch-all that appends whatever it is given to an internal base URL is an SSRF hole wearing a
 * framework's clothes: `/video-wall/stream/../../auth/me` reaches an endpoint this route was never
 * meant to expose, and path traversal in a URL is normalised in more places than anyone can hold in
 * their head. `ALLOWED` is the entire surface, matched structurally, and anything else is a 404.
 */
import { cookies } from 'next/headers';
import { API_BASE_URL } from '@/src/lib/api/client';
import { TOKEN_COOKIE } from '@/src/lib/session';

export const dynamic = 'force-dynamic';
/** Node, not edge: this carries multi-megabyte segment bodies and one abortable upstream fetch. */
export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The four shapes a tile ever asks for, and nothing else. */
function upstreamPathFor(segments: string[]): string | null {
  if (segments.length === 2 && segments[0] === 'relay' && segments[1] === 'stats') {
    return '/api/v1/streams/relay/stats';
  }
  if (segments.length !== 2) return null;
  const [cameraId, leaf] = segments;
  if (cameraId === undefined || !UUID.test(cameraId)) return null;
  if (leaf !== 'index.m3u8' && leaf !== 'media' && leaf !== 'detections' && leaf !== 'manifest') {
    return null;
  }
  return `/api/v1/streams/${cameraId}/${leaf}`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  const upstreamPath = upstreamPathFor(path);
  if (upstreamPath === null) {
    return new Response('not found', { status: 404 });
  }

  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (token === undefined || token === '') {
    // 401 rather than a redirect: `hls.js` cannot follow one usefully, and the tile renders a
    // "sign in again" state from the status.
    return new Response('session expired', { status: 401 });
  }

  const search = new URL(request.url).search;
  const upstream = await fetch(`${API_BASE_URL}${upstreamPath}${search}`, {
    headers: { authorization: `Bearer ${token}` },
    // The browser's abort — a tile unmounting mid-segment — propagates all the way to the gateway.
    // Without it, paging through a wall leaves one upstream fetch running per abandoned tile, which
    // is the leak AC 3 is about, one layer down.
    signal: request.signal,
    cache: 'no-store',
  }).catch(() => null);

  if (upstream === null) {
    return new Response('the stream service is unreachable', { status: 502 });
  }

  const headers = new Headers();
  for (const name of [
    'content-type',
    'content-length',
    'cache-control',
    'x-saakshi-relay',
    'x-saakshi-upstream-ms',
  ]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
