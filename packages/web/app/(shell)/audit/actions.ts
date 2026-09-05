'use server';

/**
 * Everything the chain viewer asks the API for.
 *
 * Server actions rather than a browser `fetch`, for D1-07's reason: the bearer token lives in an
 * httpOnly cookie and never crosses to the client.
 *
 * **A failing verification is not an error here.** "The chain is broken" is an answer, and the whole
 * value of the screen is that it renders that answer clearly instead of a stack trace — an auditor
 * needs to see which entry and why. The only thing treated as an error is not being able to ask.
 */
import { apiClient } from '@/src/lib/api/client';
import { getSession } from '@/src/lib/session';
import type { AuditView } from './types';

export interface AuditFilters {
  action?: string | undefined;
  badgeNo?: string | undefined;
  caseRef?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function loadAudit(filters: AuditFilters = {}): Promise<AuditView> {
  const session = await getSession();
  if (session === null) {
    return {
      page: null,
      chain: null,
      error: 'Your session has expired. Sign in again.',
      elapsedMs: 0,
    };
  }

  const client = apiClient(session.token);
  const started = Date.now();

  const query = {
    limit: filters.limit ?? 50,
    offset: filters.offset ?? 0,
    ...(filters.action !== undefined && filters.action !== '' ? { action: filters.action } : {}),
    ...(filters.badgeNo !== undefined && filters.badgeNo !== ''
      ? { badge_no: filters.badgeNo }
      : {}),
    ...(filters.caseRef !== undefined && filters.caseRef !== ''
      ? { case_ref: filters.caseRef }
      : {}),
    ...(filters.from !== undefined && filters.from !== '' ? { from: filters.from } : {}),
    ...(filters.to !== undefined && filters.to !== '' ? { to: filters.to } : {}),
  };

  const [search, verification] = await Promise.all([
    client.GET('/api/v1/audit', { params: { query } }),
    client.GET('/api/v1/audit/verify', {}),
  ]);

  const elapsedMs = Date.now() - started;

  if (search.data === undefined) {
    const message =
      search.response.status === 403
        ? 'Your role may not read the audit chain.'
        : `The audit chain could not be read (HTTP ${String(search.response.status)}).`;
    return { page: null, chain: verification.data ?? null, error: message, elapsedMs };
  }

  return {
    page: search.data,
    chain: verification.data ?? null,
    error: null,
    elapsedMs,
  };
}
