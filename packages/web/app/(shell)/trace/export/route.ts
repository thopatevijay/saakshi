/**
 * CSV and PDF download for a trace.
 *
 * A route handler rather than a server action, for the reason `registry/export/route.ts` states: a
 * download has to be a **navigation**. A server action returns a value to React; it cannot make the
 * browser open a save dialog. The bytes are streamed through untouched, so what a judge opens is
 * exactly what the API produced.
 */
import { getSession } from '@/src/lib/session';
import { apiClient } from '@/src/lib/api/client';
import { parseTraceQuery, toTraceApiQuery } from '@/src/lib/trace/query';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (session === null) return new Response('unauthorised', { status: 401 });

  const url = new URL(request.url);
  const format = url.searchParams.get('format') === 'pdf' ? 'pdf' : 'csv';
  const state = parseTraceQuery(url.searchParams);
  if (state.plate === '') {
    return new Response('a registration is required', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const path = format === 'pdf' ? '/api/v1/trace.pdf' : '/api/v1/trace.csv';
  const result = await apiClient(session.token).GET(path, {
    params: { query: toTraceApiQuery(state) },
    parseAs: 'stream',
  });

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
        (format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8'),
      'content-disposition': `attachment; filename="saakshi-trace-${state.plate}-${stamp}.${format}"`,
      'cache-control': 'no-store',
    },
  });
}
