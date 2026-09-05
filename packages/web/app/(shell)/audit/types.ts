/**
 * The audit viewer's shapes, taken from the generated OpenAPI document rather than restated.
 *
 * A hand-written second copy of a payload the API already publishes is how a screen ends up
 * rendering a field that no longer exists — and this particular screen is the one a judge will be
 * invited to check, so it is the last place that can afford a stale shape.
 */
import type { components, paths } from '@/src/lib/api/schema';

type AuditSearch200 =
  paths['/api/v1/audit']['get']['responses']['200']['content']['application/json'];
type ChainVerify200 =
  paths['/api/v1/audit/verify']['get']['responses']['200']['content']['application/json'];

export type AuditEntry = AuditSearch200['entries'][number];
export type AuditPage = AuditSearch200;
export type ChainVerification = ChainVerify200;

export type AuditEntryStatus = AuditEntry['status'];

/** What the screen holds, including the two failure states it must render rather than throw on. */
export interface AuditView {
  page: AuditPage | null;
  chain: ChainVerification | null;
  error: string | null;
  elapsedMs: number;
}

export type { components };
