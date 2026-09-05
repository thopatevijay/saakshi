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
 *
 * **No purpose, no request** (D3-04). The API rejects a trace with no stated purpose and it is the
 * authoritative side; this check exists so the officer sees a field waiting for an answer rather
 * than a 400 they have to interpret. Arriving from an alert's "trace this vehicle" link is exactly
 * this state, deliberately: a link can carry a registration, but only a person can state a reason.
 */
import { getSession } from '@/src/lib/session';
import { apiClient } from '@/src/lib/api/client';
import { purposeIsStated, toTraceApiQuery, type TraceQueryState } from '@/src/lib/trace/query';
import type { QueryCompileState, QueryRunState, TraceState } from './types';
import {
  canCompile,
  canRun,
  toCompileRequest,
  toRunRequest,
  type ConsoleState,
} from '@/src/lib/query-console/console';

export async function runTrace(state: TraceQueryState): Promise<TraceState> {
  if (state.plate === '') return { trace: null, error: null, elapsedMs: 0 };
  if (!purposeIsStated(state)) return { trace: null, error: null, elapsedMs: 0 };

  const session = await getSession();
  if (session === null) {
    return { trace: null, error: 'Your session has expired. Sign in again.', elapsedMs: 0 };
  }

  const started = Date.now();
  const { data, error, response } = await apiClient(session.token).GET('/api/v1/trace', {
    // `reconstruct` on: this is the screen, and the screen's whole job is the observed/inferred
    // distinction (D3-01). The CSV and PDF exports deliberately do not ask for it.
    params: { query: toTraceApiQuery(state, { reconstruct: true }) },
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

/**
 * Compile a question into a filter (D3-09). **Runs nothing.**
 *
 * A compiler that is unconfigured or failing is not an error here: the payload carries `ok: false`
 * with a message and `degradeTo: "manual_filter"`, and the console renders that as a state. Only a
 * transport or authorisation failure is an `error`, because only those are things the officer
 * cannot simply work around by using the filter below.
 */
export async function compileQuestion(state: ConsoleState): Promise<QueryCompileState> {
  if (!canCompile(state)) return { outcome: null, error: null };

  const session = await getSession();
  if (session === null) return { outcome: null, error: 'Your session has expired. Sign in again.' };

  const { data, error, response } = await apiClient(session.token).POST('/api/v1/query/compile', {
    body: toCompileRequest(state),
  });

  if (error !== undefined || data === undefined) {
    const message =
      response.status === 403
        ? 'Your role may not run investigative queries.'
        : `The question could not be compiled (HTTP ${String(response.status)}). Use the filters below.`;
    return { outcome: null, error: message };
  }
  return { outcome: data, error: null };
}

/**
 * Run a filter (D3-09).
 *
 * It sends `state.draft` — the filter as the officer left it after editing — because that is the
 * one the officer approved. The API would accept no natural-language question here even if this
 * function tried to send one: `/api/v1/query/run` has no such field.
 */
export async function runCompiledQuery(state: ConsoleState): Promise<QueryRunState> {
  const body = toRunRequest(state);
  if (body === null || !canRun(state)) return { result: null, error: null };

  const session = await getSession();
  if (session === null) return { result: null, error: 'Your session has expired. Sign in again.' };

  const { data, error, response } = await apiClient(session.token).POST('/api/v1/query/run', {
    body,
  });

  if (error !== undefined || data === undefined) {
    const message =
      response.status === 403
        ? 'Your role may not run investigative queries.'
        : `The filter could not be run (HTTP ${String(response.status)}).`;
    return { result: null, error: message };
  }
  return { result: data, error: null };
}
