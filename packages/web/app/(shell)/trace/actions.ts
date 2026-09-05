'use server';

/**
 * The one thing the trace screen asks the API for.
 *
 * A server action rather than a browser `fetch`, for D1-07's reason: the bearer token lives in an
 * httpOnly cookie and never crosses to the client, and the request and response shapes come from
 * the OpenAPI document rather than being hand-written twice.
 *
 * An empty trace is **not** an error and is never reported as one. A registration nobody has seen,
 * and a query the plate grammar refuses to read as a registration at all, are answers; the payload
 * carries `emptyReason` and the screen renders a state.
 */
import { getSession } from '@/src/lib/session';
import { apiClient } from '@/src/lib/api/client';
import { toTraceApiQuery, type TraceQueryState } from '@/src/lib/trace/query';
import type { TraceState } from './types';

export async function runTrace(state: TraceQueryState): Promise<TraceState> {
  if (state.plate === '') return { trace: null, error: null, elapsedMs: 0 };

  const session = await getSession();
  if (session === null) {
    return { trace: null, error: 'Your session has expired. Sign in again.', elapsedMs: 0 };
  }

  const started = Date.now();
  const { data, error, response } = await apiClient(session.token).GET('/api/v1/trace', {
    params: { query: toTraceApiQuery(state) },
  });

  if (error !== undefined || data === undefined) {
    // 403 is its own message: `trace:run` is deliberately not an auditor capability, and "the
    // trace failed" would send an auditor looking for a fault that is not there.
    const message =
      response.status === 403
        ? 'Your role may not run vehicle traces.'
        : `The trace could not be run (HTTP ${String(response.status)}).`;
    return { trace: null, error: message, elapsedMs: Date.now() - started };
  }

  return { trace: data, error: null, elapsedMs: Date.now() - started };
}
