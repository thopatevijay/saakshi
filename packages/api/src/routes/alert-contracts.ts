import { z } from 'zod';
import {
  AlertDigest,
  AlertRecord,
  AlertSeverity,
  AlertStatus,
  RetentionStatus,
  WatchlistCategory,
} from '@saakshi/shared';

/**
 * Wire contracts for the alert queue (D2-06).
 *
 * Separate from the handlers for the same reason the camera and watchlist contracts are: these
 * schemas are the OpenAPI document *and* the runtime validation *and* the type D2-07 renders
 * against, so one file has to own them or the three drift.
 */

export const AlertListQuery = z.object({
  status: AlertStatus.optional(),
  severity: AlertSeverity.optional(),
  category: WatchlistCategory.optional(),
  matchType: z.enum(['exact', 'fuzzy']).optional(),
  cameraId: z.uuid().optional(),
  /**
   * Every alert raised on a camera belonging to this department.
   *
   * Resolved server-side rather than by the client filtering a page it already has: the queue is
   * keyset-paginated, so a client-side department filter would drop rows out of a page and then
   * page past them, and the queue would appear to end early. Added by D2-07, whose filter row the
   * ticket specifies as severity · category · camera · **department** · time range · match type ·
   * status.
   */
  departmentId: z.uuid().optional(),
  watchlistEntryId: z.uuid().optional(),
  /** Alerts whose most recent sighting is at or after this instant. */
  since: z.iso.datetime().optional(),
  /** Alerts whose most recent sighting is at or before this instant. Pairs with `since`. */
  until: z.iso.datetime().optional(),
  /**
   * `severity` sorts by the policy's strict category rank and then by severity, which is the
   * control-room order; `recent` is newest activity first, which is the monitoring order.
   */
  sort: z.enum(['recent', 'severity']).default('recent'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Keyset cursor: the previous page's last `lastSeenAt`. */
  cursor: z.iso.datetime().optional(),
});
export type AlertListQuery = z.infer<typeof AlertListQuery>;

/**
 * An alert, plus the retention clock on the footage behind it (D3-05).
 *
 * Extended here rather than in `@saakshi/shared`'s `AlertRecord` on purpose. Retention is a
 * *rendered read* — computed against the moment of the request, from the department's declared
 * window — and `AlertRecord` is also the shape the engine writes and the SSE bus republishes. Baking
 * a countdown into the stored record would put a value in the pipeline that is stale the instant
 * after it is produced, which is the same mistake as persisting a signed URL (D2-02).
 *
 * "This evidence expires in N days" is the sentence the ticket asks the alert detail to show, and
 * this is the field it reads.
 */
export const AlertWithRetention = AlertRecord.extend({ retention: RetentionStatus });
export type AlertWithRetention = z.infer<typeof AlertWithRetention>;

export const AlertListResponse = z.object({
  data: z.array(AlertWithRetention),
  nextCursor: z.string().nullable(),
  limit: z.number().int(),
  /** Repeated on the body rather than left in a README — a screenshot has to carry it. */
  disclaimer: z.string(),
});
export type AlertListResponse = z.infer<typeof AlertListResponse>;

export const AlertTransitionBody = z.object({
  to: AlertStatus,
  /**
   * Why. Optional on the wire and defaulted to a generated sentence, because refusing a transition
   * for a missing note would leave an operator unable to clear a queue during an incident — but it
   * lands in `audit_log.purpose` either way, so the reason always exists.
   */
  note: z.string().min(1).max(500).optional(),
});
export type AlertTransitionBody = z.infer<typeof AlertTransitionBody>;

export const AlertDigestListResponse = z.object({
  data: z.array(AlertDigest),
  limit: z.number().int(),
});
export type AlertDigestListResponse = z.infer<typeof AlertDigestListResponse>;

export const AlertStatsResponse = z.object({
  bySeverityStatus: z.array(
    z.object({ severity: AlertSeverity, status: AlertStatus, count: z.number().int() }),
  ),
  byMatchType: z.array(
    z.object({ matchType: z.enum(['exact', 'fuzzy']), count: z.number().int() }),
  ),
  total: z.number().int(),
  /** Sightings collapsed into alerts by dedupe — the anti-fatigue number, measured not claimed. */
  totalSightings: z.number().int(),
  /** `1 - alerts/sightings`. 0 when there is nothing to collapse. */
  dedupeRatio: z.number(),
  /** Live delivery-cap counters for the current window. */
  rateLimit: z.object({
    windowStart: z.string(),
    delivered: z.number().int(),
    suppressed: z.number().int(),
    cap: z.number().int(),
  }),
  streamSubscribers: z.number().int(),
  policyVersion: z.number().int(),
});
export type AlertStatsResponse = z.infer<typeof AlertStatsResponse>;
