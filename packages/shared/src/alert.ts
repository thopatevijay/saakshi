import { z } from 'zod';

export const WatchlistCategory = z.enum([
  'stolen_vehicle',
  'wanted_person',
  'missing_person',
  'blacklisted_vehicle',
  'suspect',
]);
export type WatchlistCategory = z.infer<typeof WatchlistCategory>;

/**
 * Where a watchlist entry came from. There is **no live connectivity** to VAHAN / SARTHI /
 * eGujCop / AFIS / NAFIS — connectors are specified and served by a mock provider (PROJECT.md §6,
 * CLAUDE.md claims discipline). This field records the *specified* source, never a live one.
 */
export const SourceSystem = z.enum(['VAHAN', 'SARTHI', 'eGujCop', 'AFIS', 'NAFIS', 'manual']);
export type SourceSystem = z.infer<typeof SourceSystem>;

export const AlertSeverity = z.enum(['low', 'medium', 'high', 'critical']);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

export const AlertStatus = z.enum(['new', 'ack', 'dismissed', 'escalated']);
export type AlertStatus = z.infer<typeof AlertStatus>;

export const MatchType = z.enum(['exact', 'fuzzy']);
export type MatchType = z.infer<typeof MatchType>;

/**
 * The "why" payload. An operator must be able to verify an alert in three seconds (D2-07), which
 * means the alert carries its own evidence and its own reasoning — never a bare score.
 */
export const AlertReason = z.object({
  matchType: MatchType,
  /** Edit distance under the confusion-aware metric. 0 for an exact match (D2-04). */
  matchDistance: z.number().nonnegative(),
  observedPlate: z.string(),
  watchlistPlate: z.string(),
  /** Human-readable, e.g. "O→0 at position 3 — confusable pair under this camera's blur". */
  explanation: z.string(),
  plateConfidence: z.number().min(0).max(1),
  cameraTrustScore: z.number().min(0).max(100).nullable(),
});
export type AlertReason = z.infer<typeof AlertReason>;

export const Alert = z.object({
  id: z.uuid().optional(),
  watchlistEntryId: z.uuid(),
  sightingId: z.uuid(),
  cameraId: z.string().min(1),
  ts: z.iso.datetime(),

  category: WatchlistCategory,
  sourceSystem: SourceSystem,
  severity: AlertSeverity,
  confidence: z.number().min(0).max(1),
  reason: AlertReason,

  /** Stable key collapsing repeat sightings of the same vehicle on the same camera (D2-06). */
  dedupeKey: z.string().min(1),
  status: AlertStatus.default('new'),
  ackedBy: z.uuid().nullable().default(null),
  ackedAt: z.iso.datetime().nullable().default(null),
});
export type Alert = z.infer<typeof Alert>;
