/**
 * The live alert stream, proxied — the one request on this screen the browser makes for itself.
 *
 * ## Why a proxy rather than `?access_token=`
 *
 * D2-06 added a query-string token to `/api/v1/alerts/stream` because `EventSource` cannot set an
 * `Authorization` header, and that is the right answer for a non-browser client. It is the wrong
 * answer *here*: D1-07 put the bearer token in an **httpOnly** cookie precisely so that an XSS in
 * any dependency cannot read it, and handing the raw JWT to client JavaScript to build an
 * `EventSource` URL would undo that decision for the sake of one connection. It would also put the
 * token in `document.location`-adjacent state, in the browser's network panel, and in any error
 * reporter that captures request URLs.
 *
 * So the token stays where it is. This route reads the cookie on the server, opens the upstream
 * stream with a proper header, and pipes the bytes through unchanged. The browser opens
 * `new EventSource('/alerts/stream')` — same origin, no credentials in JavaScript, and the cookie
 * rides along on its own.
 *
 * ## What must not be broken in the middle
 *
 *   - **No buffering.** `x-accel-buffering: no` is forwarded and the body is piped, never
 *     accumulated. A proxy that buffers turns a live stream into a batch delivered on disconnect,
 *     and that failure looks exactly like "no alerts are firing".
 *   - **Abort propagates.** When the browser closes the `EventSource`, the upstream fetch is
 *     aborted too; otherwise every navigation away would leak a subscriber on the API and the
 *     `streamSubscribers` counter in `/alerts/stats` would climb forever.
 *   - **A failure is an SSE frame, not an HTTP error.** `EventSource` retries a failed connection
 *     forever with no way to read the status, so an unauthenticated or unreachable upstream is
 *     reported as an `event: fatal` frame the screen can render, and the stream is then closed.
 */
import { cookies } from 'next/headers';
import { API_BASE_URL } from '@/src/lib/api/client';
import { TOKEN_COOKIE } from '@/src/lib/session';

export const dynamic = 'force-dynamic';
/** Node, not edge: this holds one long-lived upstream connection per viewer. */
export const runtime = 'nodejs';

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

function fatal(message: string): Response {
  const body = `retry: 10000\nevent: fatal\ndata: ${JSON.stringify({ message })}\n\n`;
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

export async function GET(request: Request): Promise<Response> {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (token === undefined || token === '') {
    return fatal('Your session has expired. Sign in again to resume the live queue.');
  }

  const upstream = await fetch(`${API_BASE_URL}/api/v1/alerts/stream`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: request.signal,
    // Undici buffers a response body by default when it can; streaming is explicit.
    cache: 'no-store',
  }).catch(() => null);

  if (upstream === null) {
    return fatal('The alert service is unreachable. The queue below is the last page loaded.');
  }
  if (!upstream.ok || upstream.body === null) {
    return fatal(
      upstream.status === 403
        ? 'Your role may not read the alert stream.'
        : `The alert stream refused the connection (HTTP ${String(upstream.status)}).`,
    );
  }

  return new Response(upstream.body, { status: 200, headers: SSE_HEADERS });
}
