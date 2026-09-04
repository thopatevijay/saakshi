/**
 * `GET /registry/export?format=csv|json` — the download the Export button points at.
 *
 * ## Why a route handler and not a server action
 *
 * A download has to be a **navigation**. A server action returns a value to React; it cannot make
 * the browser open a save dialog, and shipping the file back through the RSC payload to build a
 * `Blob` would put the whole registry through JavaScript memory for no benefit. A plain `<a href>`
 * to this route is a normal GET, so the browser streams it to disk and the `content-disposition`
 * the API already sets is honoured.
 *
 * ## Why the app proxies rather than linking straight to the API
 *
 * The bearer token is httpOnly. Browser JavaScript cannot read it, which is the point — so an
 * `<a href="http://api/…">` would arrive unauthenticated. This handler reads the cookie on the
 * server, calls the API through the **generated client** (`parseAs: 'stream'`, so the CSV is never
 * parsed or buffered), and pipes the body straight through.
 *
 * ## The round trip this exists to support
 *
 * The API's CSV column order matches `fixtures/cameras-bulk-sample.csv` on purpose, so an export
 * re-imports as an **update** of the same rows, not a duplicate set: the importer upserts on
 * `(department_id, external_id)`. `scripts/verify-roundtrip.mjs` proves it — export, re-import,
 * assert `created 0` and an unchanged row count.
 */
import { getSession } from '@/src/lib/session';
import { apiClient } from '@/src/lib/api/client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (session === null) return new Response('unauthorised', { status: 401 });

  const url = new URL(request.url);
  const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
  const departmentId = url.searchParams.get('departmentId');

  const result = await apiClient(session.token).GET('/api/v1/cameras/export', {
    params: {
      query: {
        format,
        ...(departmentId !== null && departmentId !== '' ? { departmentId } : {}),
      },
    },
    // Never parsed: the point is to hand the bytes to the browser exactly as the API produced them.
    parseAs: 'stream',
  });

  // The route has no `response` schema on the API side, so the generated types describe no
  // content. `response` is always the real `Response`; read it before narrowing on `data`.
  const upstream: Response = result.response;
  const body = result.data as ReadableStream | undefined;

  if (body === undefined || !upstream.ok) {
    return new Response(`the export failed (HTTP ${String(upstream.status)})`, {
      status: upstream.status === 0 ? 502 : upstream.status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type':
        upstream.headers.get('content-type') ??
        (format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json'),
      'content-disposition': `attachment; filename="saakshi-cameras-${stamp}.${format}"`,
      // An export is a point-in-time snapshot and an audited action; caching one would serve a
      // stale estate and hide the second request from the audit log.
      'cache-control': 'no-store',
    },
  });
}
