/**
 * The crop's one same-origin hop (D4-09).
 *
 * Identical in shape and reasoning to `video-wall/stream/[...path]/route.ts` and
 * `alerts/stream/route.ts`: the browser asks *us*, on our own origin, with no credentials in
 * JavaScript, and this handler reads the httpOnly cookie on the server and forwards a bearer.
 *
 * ## Why a crop is not simply a presigned URL any more
 *
 * It was, and it was a broken image for every judge. SigV4 binds the `Host` header, so a presigned
 * URL only works when the host that signed it is the host the browser resolves — and on the
 * deployment the object store answers to `minio.railway.internal`, which exists only on Railway's
 * private network (BL-01 finding 18). Publishing the object store would have fixed the image and
 * cost the argument: a presigned URL is a bearer credential for its whole TTL, usable by anyone
 * holding it. The API now streams the bytes behind the session instead.
 *
 * ## Why the `uri` is forwarded but not trusted
 *
 * This handler does not interpret the URI at all — it hands it to the API, which is where the
 * bucket-prefix guard and the role check live, and which answers 404 for anything it cannot serve.
 * What this handler *does* refuse is a request with no `uri` at all, so the API is never asked to
 * validate an empty one. It is not a pass-through in the dangerous sense: the upstream path is a
 * constant, so no part of the request can steer which endpoint is reached.
 */
import { cookies } from 'next/headers';
import { API_BASE_URL } from '@/src/lib/api/client';
import { TOKEN_COOKIE } from '@/src/lib/session';

export const dynamic = 'force-dynamic';
/** Node, not edge: this carries image bodies and one abortable upstream fetch. */
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const uri = new URL(request.url).searchParams.get('uri');
  if (uri === null || uri === '') {
    return new Response('not found', { status: 404 });
  }

  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (token === undefined || token === '') {
    // 401 rather than a redirect: an `<img>` cannot follow one usefully, and the evidence strip
    // renders its "no crop" state from the failure.
    return new Response('session expired', { status: 401 });
  }

  const upstream = await fetch(
    `${API_BASE_URL}/api/v1/evidence/crop?uri=${encodeURIComponent(uri)}`,
    {
      headers: { authorization: `Bearer ${token}` },
      // A navigation away mid-image aborts the upstream read rather than leaving it running.
      signal: request.signal,
      cache: 'no-store',
    },
  ).catch(() => null);

  if (upstream === null) {
    return new Response('the evidence store is unreachable', { status: 502 });
  }

  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'cache-control', 'etag']) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
