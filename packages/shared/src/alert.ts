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

/** Ascending. `SEVERITY_ORDER[a] < SEVERITY_ORDER[b]` means `a` is the less serious of the two. */
export const SEVERITY_ORDER: Readonly<Record<AlertSeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export const AlertStatus = z.enum(['new', 'ack', 'dismissed', 'escalated']);
export type AlertStatus = z.infer<typeof AlertStatus>;

export const MatchType = z.enum(['exact', 'fuzzy']);
export type MatchType = z.infer<typeof MatchType>;

/**
 * How confident the *identification* is, as a word rather than a number.
 *
 * D2-01 measured **0 exact plate reads** across a 120-instance hand-labelled sample of this estate,
 * and D2-03 correctly rejected all 15 strings the live run produced. On input like that, a number
 * alone invites an officer to read 0.47 as "roughly half right" when the honest statement is "this
 * is a lead, not an identification". The word is what the UI leads with; the number is beside it.
 */
export const IdentificationStrength = z.enum(['confirmed', 'probable', 'possible', 'weak']);
export type IdentificationStrength = z.infer<typeof IdentificationStrength>;

/** Where an alert's severity ended up, and every rule that moved it. */
export const SeverityBasis = z.object({
  /** From `config/alert-policy.json`'s `severity.byCategory` — never from a model's opinion. */
  fromCategory: AlertSeverity,
  /** The severity the watchlist entry itself declares. Applied per `severity.entrySeverity`. */
  fromEntry: AlertSeverity,
  /** Ceilings that fired, in the order they were applied. Empty when nothing capped it. */
  ceilingsApplied: z.array(z.string()),
  final: AlertSeverity,
  /** The ticket's strict category ordering, for queue sort. 1 is the most serious. */
  categoryRank: z.number().int().positive(),
});
export type SeverityBasis = z.infer<typeof SeverityBasis>;

/** The camera, enough of it to go and look. */
export const AlertCamera = z.object({
  id: z.uuid(),
  externalId: z.string().min(1),
  name: z.string().min(1),
  /** `null` for a camera with no geometry in the registry — a Pillar 1 finding, stated as a caveat. */
  location: z.object({ lat: z.number(), lon: z.number() }).nullable(),
  district: z.string().nullable(),
  /** 0-100, or `null` when the camera has never been probed. Never scored 0 for being unmeasured. */
  trustScore: z.number().min(0).max(100).nullable(),
});
export type AlertCamera = z.infer<typeof AlertCamera>;

/** The sighting, in the camera's own time base. */
export const AlertSighting = z.object({
  id: z.uuid(),
  /** PTS-derived instant. Never frame arrival time (CLAUDE.md, D1-09). */
  ts: z.iso.datetime(),
  /** The raw presentation timestamp the frame carried, in ms. */
  framePtsMs: z.number(),
  /** Session-qualified: `session * 100_000 + tracker_id`. Never the raw tracker id. */
  trackId: z.number().int(),
  vehicleClass: z.string().min(1),
});
export type AlertSighting = z.infer<typeof AlertSighting>;

/** The crop an officer clicks. */
export const AlertEvidence = z.object({
  /** `s3://bucket/key`. Never a URL — a signed URL expires and would rot in the database (D2-02). */
  cropUri: z.string().nullable(),
  /** Minted at read time, GET-signed. `null` when no object store is configured. */
  cropUrl: z.string().nullable(),
  cropUrlExpiresInS: z.number().int().positive(),
  isBestShot: z.boolean(),
});
export type AlertEvidence = z.infer<typeof AlertEvidence>;

/** The matched record, with its provenance intact. */
export const AlertWatchlistRecord = z.object({
  entryId: z.uuid(),
  category: WatchlistCategory,
  entityType: z.enum(['vehicle', 'person']),
  plateNormalized: z.string().nullable(),
  personRef: z.string().nullable(),
  /** The system this record is *modelled on*. Never evidence of a live lookup. */
  sourceSystem: SourceSystem,
  sourceRef: z.string().nullable(),
  /** The provider that answered — always a mock in this repository. */
  providerSystem: SourceSystem,
  /** `false` for every provider that ships. Present so a screenshot cannot imply otherwise. */
  live: z.literal(false),
  entrySeverity: AlertSeverity,
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
  /** The seed row's own provenance note, verbatim. Several seeded plates are OCR output, not
   *  registrations, and that has to travel with the alert. */
  note: z.string().nullable(),
});
export type AlertWatchlistRecord = z.infer<typeof AlertWatchlistRecord>;

/** What D2-03 made of the read, so a fuzzy alert can be argued with rather than only believed. */
export const AlertIdentification = z.object({
  /** Canonical form of what the camera actually produced, before correction. */
  observedPlate: z.string(),
  /** After D2-03's slot-aware correction. Equals `observedPlate` when nothing was corrected. */
  correctedPlate: z.string(),
  /** The watchlist entry's plate, or its person reference. */
  watchlistValue: z.string(),
  validity: z.enum(['valid', 'partial', 'invalid']),
  grammarValid: z.boolean(),
  grammarCorrected: z.boolean(),
  /** D2-03 rejection codes, `[]` when the read is a complete valid registration. */
  rejectionCodes: z.array(z.string()),
  /**
   * Characters short of a complete registration. `0` when valid, `null` when nothing matched any
   * layout — the two are different and collapsing them would hide which.
   */
  missingChars: z.number().int().nonnegative().nullable(),
  /** `corrected.length / layout.length` of the chosen layout; `0` when nothing matched. */
  completeness: z.number().min(0).max(1),
  /** Raw OCR confidence, as the model reported it. */
  plateConfidence: z.number().min(0).max(1),
  /** OCR confidence after D2-03's grammar down-weighting. */
  adjustedPlateConfidence: z.number().min(0).max(1),
  /** Match strength in `[0,1]`. `1` for exact. **Not** OCR confidence. */
  matchConfidence: z.number().min(0).max(1),
  /**
   * `adjustedPlateConfidence × matchConfidence`.
   *
   * A **product**, not a mean or a maximum, because the two are independent failure modes and both
   * have to hold: reading the plate right and matching it to the right record. A mean lets a
   * confident read of the wrong string look like a good alert.
   */
  combinedConfidence: z.number().min(0).max(1),
  strength: IdentificationStrength,
});
export type AlertIdentification = z.infer<typeof AlertIdentification>;

/**
 * The "why" payload. An operator must be able to verify an alert in three seconds (D2-07), which
 * means the alert carries its own evidence and its own reasoning — never a bare score.
 *
 * Every field here is populated by construction. The three that may legitimately be `null` —
 * `camera.location`, `camera.trustScore`, `evidence.cropUrl` — must each be accompanied by an
 * entry in `caveats` saying so, and `alerts.test.ts` (AC 5) asserts exactly that.
 */
export const AlertReason = z.object({
  matchType: MatchType,
  /**
   * Distance under D2-04's confusion-aware metric. `0` for exact.
   *
   * **Continuous, not an integer** — `GJ35U07 → GJ35U0779` is 0.70. Do not round it for display
   * without saying that you rounded.
   */
  matchDistance: z.number().nonnegative(),
  /** The matcher's own words, e.g. "O→0 at position 3 — confusable pair under this camera's blur". */
  explanation: z.string().min(1),

  identification: AlertIdentification,
  severityBasis: SeverityBasis,
  camera: AlertCamera,
  sighting: AlertSighting,
  evidence: AlertEvidence,
  watchlistRecord: AlertWatchlistRecord,

  /**
   * Everything the officer must know before acting, in plain words: that the match is fuzzy, that
   * the plate is a fragment, that the crop is unavailable, that no live registry was consulted.
   *
   * Never empty. Even a perfect exact match carries the mock-provider disclaimer, because the one
   * claim that must never be implied is that VAHAN answered.
   */
  caveats: z.array(z.string()).min(1),
  /** The mock-provider disclaimer, repeated on the payload so a screenshot carries it. */
  disclaimer: z.string().min(1),
  /** `config/alert-policy.json`'s version, so an alert can be re-derived from the policy that made it. */
  policyVersion: z.number().int(),
});
export type AlertReason = z.infer<typeof AlertReason>;

/**
 * Dot-paths into `AlertReason` that must never be null, empty or absent.
 *
 * Exported rather than inlined in the test, because "every alert carries a complete why payload"
 * is a contract D2-07 renders against and D3-04 hashes — a list two files can disagree about is
 * not a contract.
 */
export const REQUIRED_WHY_FIELDS = [
  'matchType',
  'matchDistance',
  'explanation',
  'identification.observedPlate',
  'identification.correctedPlate',
  'identification.watchlistValue',
  'identification.validity',
  'identification.completeness',
  'identification.plateConfidence',
  'identification.adjustedPlateConfidence',
  'identification.matchConfidence',
  'identification.combinedConfidence',
  'identification.strength',
  'severityBasis.fromCategory',
  'severityBasis.fromEntry',
  'severityBasis.final',
  'severityBasis.categoryRank',
  'camera.id',
  'camera.externalId',
  'camera.name',
  'sighting.id',
  'sighting.ts',
  'sighting.framePtsMs',
  'sighting.trackId',
  'sighting.vehicleClass',
  'evidence.cropUrlExpiresInS',
  'evidence.isBestShot',
  'watchlistRecord.entryId',
  'watchlistRecord.category',
  'watchlistRecord.entityType',
  'watchlistRecord.sourceSystem',
  'watchlistRecord.providerSystem',
  'watchlistRecord.live',
  'watchlistRecord.entrySeverity',
  'watchlistRecord.validFrom',
  'caveats',
  'disclaimer',
  'policyVersion',
] as const;

/**
 * The three fields that may be `null`, and the caveat each must produce when it is.
 *
 * A null with a stated reason is information; a null without one is a gap. The AC-5 test walks this
 * map and fails an alert whose null is unexplained.
 */
export const EXPLAINED_NULL_FIELDS: Readonly<Record<string, string>> = {
  'camera.location': 'no location on file',
  'camera.trustScore': 'never probed',
  'evidence.cropUrl': 'no crop URL',
};

/**
 * One alert as the API serves it — the shape D2-07 renders and D3-04 hashes.
 *
 * `ts` is the FIRST sighting, `lastSeenAt` the most recent, and `sightingCount` how many were
 * collapsed between them. A control room reads all three as one sentence: *"first seen 14:02, seen
 * again 14:19, 23 times"*.
 */
export const AlertRecord = z.object({
  id: z.uuid(),
  watchlistEntryId: z.uuid(),
  sightingId: z.uuid(),
  cameraId: z.uuid(),
  /** First sighting on this alert. */
  ts: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  sightingCount: z.number().int().positive(),
  lastObservedPlate: z.string().nullable(),

  category: WatchlistCategory,
  sourceSystem: SourceSystem,
  severity: AlertSeverity,
  matchType: MatchType,
  matchDistance: z.number().nonnegative(),
  /** The combined identification confidence — the same number as `reason.identification.combined`. */
  confidence: z.number().min(0).max(1),
  reason: AlertReason,

  /** Stable key collapsing repeat sightings of the same vehicle on the same camera (D2-06). */
  dedupeKey: z.string().min(1),
  dedupeWindowStart: z.iso.datetime(),

  status: AlertStatus,
  ackedBy: z.uuid().nullable(),
  ackedAt: z.iso.datetime().nullable(),
  statusChangedBy: z.uuid().nullable(),
  statusChangedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type AlertRecord = z.infer<typeof AlertRecord>;

/**
 * Legacy alias. `Alert` was the pre-D2-06 name and D2-07's early scaffolding may import it.
 * `AlertRecord` is the shape; this keeps one name for it.
 */
export const Alert = AlertRecord;
export type Alert = AlertRecord;

/**
 * The lifecycle, as a graph rather than as scattered `if`s.
 *
 * `dismissed` is terminal on purpose: an operator who dismissed an alert made a judgement, and
 * quietly re-opening it would hide that the judgement was overridden. Re-raising means a new
 * sighting and a new alert, which is a fact rather than an edit.
 */
export const ALERT_TRANSITIONS: Readonly<Record<AlertStatus, readonly AlertStatus[]>> = {
  new: ['ack', 'dismissed', 'escalated'],
  ack: ['dismissed', 'escalated'],
  escalated: ['ack', 'dismissed'],
  dismissed: [],
};

export function canTransition(from: AlertStatus, to: AlertStatus): boolean {
  return ALERT_TRANSITIONS[from].includes(to);
}

/** The digest a suppressed minute produces. Named events, so a client can branch on the type. */
export const AlertDigest = z.object({
  id: z.uuid(),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  suppressedCount: z.number().int().nonnegative(),
  deliveredCount: z.number().int().nonnegative(),
  bySeverity: z.record(z.string(), z.number()),
  byCategory: z.record(z.string(), z.number()),
  byCamera: z.record(z.string(), z.number()),
  /** Ids of a few suppressed alerts, so the digest is actionable rather than only a number. */
  sample: z.array(z.uuid()),
});
export type AlertDigest = z.infer<typeof AlertDigest>;
