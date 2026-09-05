/**
 * The evidence clock's shapes, taken from the generated OpenAPI document rather than restated.
 *
 * A hand-written second copy of a payload the API already publishes is how a screen ends up
 * rendering a field that no longer exists. Same rule as the audit viewer's `types.ts`.
 */
import type { paths } from '@/src/lib/api/schema';

type Availability200 =
  paths['/api/v1/evidence/availability']['get']['responses'][200]['content']['application/json'];
type RetentionSummary200 =
  paths['/api/v1/evidence/retention/summary']['get']['responses'][200]['content']['application/json'];
type PreservationQueue200 =
  paths['/api/v1/evidence/preservation']['get']['responses'][200]['content']['application/json'];

export type Availability = Availability200;
export type CameraRetention = Availability200['covering'][number];
export type RetentionSummary = RetentionSummary200;
export type PreservationQueue = PreservationQueue200;
export type PreservationRequest = PreservationQueue200['data'][number];

/** What the screen holds, including the failure states it renders rather than throws on. */
export interface EvidenceView {
  availability: Availability | null;
  summary: RetentionSummary | null;
  queue: PreservationQueue | null;
  error: string | null;
  elapsedMs: number;
}

/** The availability question, as it lives in the URL. A search is a link somebody can share. */
export interface AvailabilityQueryState {
  lat: string;
  lon: string;
  radiusM: string;
  at: string;
  expiringSoonHours: string;
}

export interface PreservationFormState {
  ok: boolean;
  message: string | null;
  /** The chain entry that authorised it, echoed so the officer can find it in the audit viewer. */
  auditHash: string | null;
}
