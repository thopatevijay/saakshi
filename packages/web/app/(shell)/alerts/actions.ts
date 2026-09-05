'use server';

/**
 * Everything the alert queue asks the API for.
 *
 * Server actions rather than browser `fetch`, for D1-07's reason: the bearer token lives in an
 * httpOnly cookie and never crosses to the client, and every request and response shape comes from
 * the OpenAPI document instead of being hand-written a second time.
 *
 * The one thing that cannot be a server action is the **live stream** — `EventSource` opens its own
 * connection. That is why `stream/route.ts` exists.
 */
import { AlertRecord } from '@saakshi/shared';
import { apiClient } from '@/src/lib/api/client';
import { getSession } from '@/src/lib/session';
import { toApiQuery, type AlertQueryState } from '@/src/lib/alerts/query';
import type { AlertPage, FilterOptions, TransitionResult } from './types';

const EMPTY_DISCLAIMER =
  'MOCK PROVIDERS — SAAKSHI has no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity.';

/**
 * One page of the queue.
 *
 * The records are re-parsed through `AlertRecord` rather than cast. The API validates its own
 * response, so this is belt and braces — but the payload this screen renders is the one D3-04
 * hashes into the audit chain, and a shape that quietly drifted would be discovered by a judge
 * rather than by a test.
 */
export async function loadAlerts(state: AlertQueryState, cursor?: string): Promise<AlertPage> {
  const session = await getSession();
  if (session === null) {
    return {
      alerts: [],
      nextCursor: null,
      disclaimer: EMPTY_DISCLAIMER,
      error: 'Your session has expired. Sign in again.',
      elapsedMs: 0,
    };
  }

  const started = Date.now();
  const { data, error, response } = await apiClient(session.token).GET('/api/v1/alerts', {
    params: { query: toApiQuery(state, cursor) },
  });

  if (error !== undefined || data === undefined) {
    return {
      alerts: [],
      nextCursor: null,
      disclaimer: EMPTY_DISCLAIMER,
      error: `The alert queue could not be loaded (HTTP ${String(response.status)}).`,
      elapsedMs: Date.now() - started,
    };
  }

  const parsed = AlertRecord.array().safeParse(data.data);
  if (!parsed.success) {
    return {
      alerts: [],
      nextCursor: null,
      disclaimer: data.disclaimer,
      error: 'The API returned an alert this build does not understand. Regenerate the API client.',
      elapsedMs: Date.now() - started,
    };
  }

  return {
    alerts: parsed.data,
    nextCursor: data.nextCursor,
    disclaimer: data.disclaimer,
    error: null,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Move one alert through its lifecycle.
 *
 * **409 is a normal outcome, not a fault.** D2-06 is explicit: another operator may have moved this
 * alert between the moment the row rendered and the moment the key was pressed, and `dismissed` is
 * terminal. The screen rolls back and says who won, rather than showing an error dialog.
 */
export async function transition(
  id: string,
  to: 'ack' | 'dismissed' | 'escalated',
  note?: string,
): Promise<TransitionResult> {
  const session = await getSession();
  if (session === null) {
    return { ok: false, kind: 'error', message: 'Your session has expired. Sign in again.' };
  }

  // The API defaults a missing note, but dismiss is terminal and this screen refuses to let one
  // through without a reason — the client-side guard is the courtesy, this is the boundary.
  if (to === 'dismissed' && (note === undefined || note.trim() === '')) {
    return { ok: false, kind: 'error', message: 'A dismissal needs a reason.' };
  }

  const { data, error, response } = await apiClient(session.token).POST(
    '/api/v1/alerts/{id}/transition',
    {
      params: { path: { id } },
      body: { to, ...(note === undefined || note.trim() === '' ? {} : { note: note.trim() }) },
    },
  );

  if (error !== undefined || data === undefined) {
    if (response.status === 409) {
      return {
        ok: false,
        kind: 'conflict',
        message: 'Another operator moved this alert first. Refreshed to their version.',
      };
    }
    if (response.status === 403) {
      return { ok: false, kind: 'forbidden', message: 'Your role may not action alerts.' };
    }
    if (response.status === 404) {
      return { ok: false, kind: 'gone', message: 'That alert no longer exists.' };
    }
    return {
      ok: false,
      kind: 'error',
      message: `The alert could not be updated (HTTP ${String(response.status)}).`,
    };
  }

  const parsed = AlertRecord.safeParse(data);
  if (!parsed.success) {
    return { ok: false, kind: 'error', message: 'The API returned an unexpected alert shape.' };
  }
  return { ok: true, alert: parsed.data };
}

/**
 * Re-read one alert.
 *
 * The reason this exists at all is the crop: `reason.evidence.cropUrl` is minted per response and
 * signed for 900 s, so a queue left open through a shift has dead thumbnails. Expanding a row
 * refetches it rather than reusing the URL the page loaded with. `cropUri` is the stable identifier;
 * the URL never is.
 */
export async function reloadAlert(id: string): Promise<AlertRecord | null> {
  const session = await getSession();
  if (session === null) return null;

  const { data, error } = await apiClient(session.token).GET('/api/v1/alerts/{id}', {
    params: { path: { id } },
  });
  if (error !== undefined || data === undefined) return null;

  const parsed = AlertRecord.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Camera and department names for the filter row, so it shows names rather than uuids. */
export async function loadFilterOptions(): Promise<FilterOptions> {
  const session = await getSession();
  if (session === null) return { cameras: [], departments: [] };
  const client = apiClient(session.token);

  const [cameras, departments] = await Promise.all([
    client.GET('/api/v1/cameras', { params: { query: { limit: 500 } } }),
    client.GET('/api/v1/departments', { params: { query: { limit: 500 } } }),
  ]);

  return {
    cameras: (cameras.data?.data ?? [])
      .map((camera) => ({ id: camera.id, label: `${camera.externalId} · ${camera.name}` }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    departments: (departments.data?.data ?? [])
      .map((department) => ({ id: department.id, label: department.code }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}
