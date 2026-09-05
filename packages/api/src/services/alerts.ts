/**
 * The alert engine (D2-06).
 *
 * ## The failure this module is designed against
 *
 * **The real failure mode of an alert system is fatigue, not accuracy.** 80,000 cameras with naive
 * alerting produces a firehose, and a firehose gets switched off — after which the accuracy of the
 * detector is irrelevant, because nobody is reading it. Three mechanisms here exist for that reason
 * and no other:
 *
 * 1. **Dedupe.** The same vehicle at the same camera inside one window is one alert with a sighting
 *    count. Camera-scoped, because the same vehicle at a *different* camera is movement, and
 *    movement is the thing a control room is watching for.
 * 2. **Severity that can only be lowered by weak identification.** The category decides how serious
 *    the *record* is; the read decides how sure we are that this is that record. The second can
 *    never raise the first, and it caps it hard.
 * 3. **A delivery cap with a digest.** Overflow is summarised, never dropped. Every alert row is
 *    written whatever happens — what is capped is the operator's queue, not the evidence.
 *
 * ## Why the ceilings are not pessimism
 *
 * D2-01 measured **0 exact plate reads** across a 120-instance hand-labelled sample of this estate,
 * because only 3 plates were legible at all. D2-03 then correctly rejected all 15 strings the live
 * run produced — including `757508300`, a hoarding's phone number on cam05, which was the single
 * highest-confidence read of the entire run at 0.888. An engine that fires `critical` on input like
 * that is manufacturing certainty from noise. The ceilings are the arithmetic that stops it, and
 * every one that fires is named in the alert's own payload so an officer can see why the system is
 * hedging.
 *
 * ## What is audited, and where
 *
 * D2-05's handoff notes that calling the registry **in process** bypasses the HTTP route's audit
 * write. Both halves are covered here rather than one:
 *
 * - `watchlist.lookup.auto` — one row per correlation batch, carrying how many plates were looked
 *   up and how many hit. Per-lookup would be one serialised hash-chain write per plate read, which
 *   at 28,438 sightings is a chain longer than the data it describes and a hard serialisation point
 *   in the ingest path.
 * - `alert.raise` — one row per alert actually created, and one per lifecycle transition. The
 *   decision, not the query, is the thing a review asks about.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ALERT_TRANSITIONS,
  AlertSeverity,
  SEVERITY_ORDER,
  canTransition,
  evaluatePlateRead,
  type AlertDigest,
  type AlertIdentification,
  type AlertReason,
  type AlertRecord,
  type AlertStatus,
  type IdentificationStrength,
  type PlateReadEvaluation,
  type WatchlistCategory,
} from '@saakshi/shared';
import type { Db, DbLike } from '../db/client.js';
import type { Principal } from '../auth.js';
import { writeAudit } from '../audit.js';
import { evidenceStoreFromEnv, type EvidenceStore } from './evidence.js';
import { presignerFor } from './crop-url.js';
import type { CropPresigner } from './trace.js';
import type { WatchlistHit, WatchlistRegistry } from '../watchlist/index.js';

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/* Policy                                                                                          */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

const CategoryRecord = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    stolen_vehicle: value,
    wanted_person: value,
    missing_person: value,
    blacklisted_vehicle: value,
    suspect: value,
  });

export const IdentificationCeiling = z
  .object({
    id: z.string().min(1),
    when: z
      .object({
        matchType: z.enum(['exact', 'fuzzy']).optional(),
        validity: z.enum(['valid', 'partial', 'invalid']).optional(),
        combinedConfidenceBelow: z.number().min(0).max(1).optional(),
      })
      .loose(),
    maxSeverity: AlertSeverity,
  })
  .loose();
export type IdentificationCeiling = z.infer<typeof IdentificationCeiling>;

export const AlertPolicy = z
  .object({
    version: z.number().int(),
    dedupe: z
      .object({
        windowMinutes: z.number().positive(),
        scope: z.literal('camera'),
      })
      .loose(),
    severity: z
      .object({
        byCategory: CategoryRecord(AlertSeverity),
        categoryRank: CategoryRecord(z.number().int().positive()),
        entrySeverity: z.enum(['ceiling', 'ignore', 'override']),
        identificationCeilings: z.array(IdentificationCeiling),
      })
      .loose(),
    correlation: z
      .object({
        maxDistance: z.number().nonnegative(),
        limit: z.number().int().positive(),
        fuzzyRefusalCodes: z.array(z.string()),
        minPlateConfidence: z.number().min(0).max(1),
      })
      .loose(),
    rateLimit: z
      .object({
        deliveriesPerMinute: z.number().int().positive(),
        windowSeconds: z.number().int().positive(),
        digestSampleSize: z.number().int().nonnegative(),
      })
      .loose(),
    evidence: z.object({ cropUrlExpiresInS: z.number().int().positive() }).loose(),
  })
  .loose();
export type AlertPolicy = z.infer<typeof AlertPolicy>;

export const POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../config/alert-policy.json',
);

let cachedPolicy: AlertPolicy | undefined;

/**
 * Loads the policy from `config/alert-policy.json`.
 *
 * Read from disk rather than imported, because the acceptance criterion is that **a config change
 * alters severity with no code change**. A bundled import would make the policy a build input, and
 * the criterion would be satisfied only by rebuilding — which is not what "no code change" means.
 */
export function loadAlertPolicy(configPath: string = POLICY_PATH): AlertPolicy {
  if (configPath === POLICY_PATH && cachedPolicy !== undefined) return cachedPolicy;
  const parsed = AlertPolicy.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  if (configPath === POLICY_PATH) cachedPolicy = parsed;
  return parsed;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/* Severity                                                                                        */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

const lower = (a: AlertSeverity, b: AlertSeverity): AlertSeverity =>
  SEVERITY_ORDER[a] <= SEVERITY_ORDER[b] ? a : b;

export interface SeverityInput {
  category: WatchlistCategory;
  entrySeverity: AlertSeverity;
  matchType: 'exact' | 'fuzzy';
  validity: 'valid' | 'partial' | 'invalid';
  combinedConfidence: number;
}

export interface SeverityOutcome {
  fromCategory: AlertSeverity;
  fromEntry: AlertSeverity;
  ceilingsApplied: string[];
  final: AlertSeverity;
  categoryRank: number;
}

/**
 * Severity from the category, then lowered — never raised — by identification quality.
 *
 * The order matters and is deliberate: the *record's* seriousness is decided first and by policy
 * alone, so "how bad is a stolen vehicle" is a question a department answers in a JSON file. Only
 * then does the read get a say, and its only power is to cap. A system where the detector's
 * confidence could *raise* severity is a system where a confident misread outranks a human's
 * judgement about a case.
 */
export function severityFor(policy: AlertPolicy, input: SeverityInput): SeverityOutcome {
  const fromCategory = policy.severity.byCategory[input.category];
  const fromEntry = input.entrySeverity;
  const mode = policy.severity.entrySeverity;

  let current =
    mode === 'override'
      ? fromEntry
      : mode === 'ceiling'
        ? lower(fromCategory, fromEntry)
        : fromCategory;

  const ceilingsApplied: string[] = [];
  if (mode === 'ceiling' && SEVERITY_ORDER[fromEntry] < SEVERITY_ORDER[fromCategory]) {
    ceilingsApplied.push('entry-severity');
  }

  for (const ceiling of policy.severity.identificationCeilings) {
    const { matchType, validity, combinedConfidenceBelow } = ceiling.when;
    if (matchType !== undefined && matchType !== input.matchType) continue;
    if (validity !== undefined && validity !== input.validity) continue;
    if (
      combinedConfidenceBelow !== undefined &&
      !(input.combinedConfidence < combinedConfidenceBelow)
    ) {
      continue;
    }
    const capped = lower(current, ceiling.maxSeverity);
    if (capped !== current) {
      current = capped;
      ceilingsApplied.push(ceiling.id);
    }
  }

  return {
    fromCategory,
    fromEntry,
    ceilingsApplied,
    final: current,
    categoryRank: policy.severity.categoryRank[input.category],
  };
}

/**
 * The word an officer reads first.
 *
 * Thresholds are the same boundaries the policy's confidence ceilings use, so the label and the
 * severity cannot tell different stories. `confirmed` additionally requires an exact match on a
 * grammar-valid registration: on this estate that has never once happened, and a label that can be
 * earned by a fragment is a label that means nothing.
 */
export function identificationStrength(
  combined: number,
  matchType: 'exact' | 'fuzzy',
  grammarValid: boolean,
): IdentificationStrength {
  if (matchType === 'exact' && grammarValid && combined >= 0.8) return 'confirmed';
  if (combined >= 0.55) return 'probable';
  if (combined >= 0.3) return 'possible';
  return 'weak';
}

/**
 * `file://` out of `file:///Users/…/100-plate.jpg` — the scheme only, never the path (D2-11).
 *
 * The caveat has to say *why* a crop could not be signed, and the scheme is the whole answer. The
 * path is not: a `file://` crop URI is an absolute path on the analytics worker's disk, and putting
 * one in an alert payload that leaves the building leaks the layout of a police server for nothing.
 */
function uriScheme(uri: string): string {
  const end = uri.indexOf('://');
  return end === -1 ? 'no scheme' : `${uri.slice(0, end + 3)}…`;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/* The live bus                                                                                    */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

export type AlertBusEvent =
  { type: 'alert'; alert: AlertRecord; deduped: boolean } | { type: 'digest'; digest: AlertDigest };

/**
 * In-process fan-out to every open SSE connection.
 *
 * Deliberately in-process and deliberately not durable: an SSE stream is a *live* view, and a
 * client that was disconnected catches up with `GET /api/v1/alerts`, which reads the table. Making
 * the bus durable would be reimplementing the database that already holds every alert.
 */
export class AlertBus {
  private readonly emitter = new EventEmitter();
  /**
   * Ids published very recently, so the same event arriving twice is delivered once.
   *
   * Two paths feed this bus: the engine publishes directly when it runs in the API's own process,
   * and `AlertNotifyBridge` replays what another process raised. In a single-process deployment
   * both fire for the same alert, and an operator seeing every alert twice would be a worse bug
   * than either path being missing.
   */
  private readonly recent = new Map<string, number>();
  private static readonly DEDUPE_MS = 10_000;

  constructor() {
    // A control room with many wall-boards is a legitimate high-listener case, and the default
    // warning at 10 would fire on it and say nothing useful.
    this.emitter.setMaxListeners(0);
  }

  /** A key that changes whenever the event is genuinely new information about the same alert. */
  private static key(event: AlertBusEvent): string {
    return event.type === 'alert'
      ? `alert:${event.alert.id}:${String(event.alert.sightingCount)}`
      : `digest:${event.digest.id}:${String(event.digest.suppressedCount)}`;
  }

  publish(event: AlertBusEvent): void {
    const key = AlertBus.key(event);
    const now = Date.now();
    for (const [seen, at] of this.recent) {
      if (now - at > AlertBus.DEDUPE_MS) this.recent.delete(seen);
    }
    if (this.recent.has(key)) return;
    this.recent.set(key, now);
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: AlertBusEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount('event');
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/* Delivery cap and digest                                                                         */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

interface DigestDraft {
  windowStart: number;
  delivered: number;
  suppressed: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  byCamera: Record<string, number>;
  sample: string[];
}

const emptyDraft = (windowStart: number): DigestDraft => ({
  windowStart,
  delivered: 0,
  suppressed: 0,
  bySeverity: {},
  byCategory: {},
  byCamera: {},
  sample: [],
});

const bump = (into: Record<string, number>, key: string): void => {
  into[key] = (into[key] ?? 0) + 1;
};

/**
 * A fixed-window cap on how many alerts reach the operator per minute.
 *
 * Fixed windows rather than a token bucket, and that is the honest choice for this job: the cap has
 * to be *reportable* — "in the 14:02 minute you were shown 120 and not shown 380" is a sentence a
 * digest can make, and a bucket that refills continuously cannot make it. The cost is the usual
 * fixed-window edge case (up to 2× the cap across a boundary), which for a human queue is not a
 * failure at all.
 *
 * **Nothing is dropped.** A suppressed alert is already in the database; it is counted, bucketed by
 * severity, category and camera, and a sample of ids is kept so the digest is actionable.
 */
export class DeliveryGate {
  private readonly windowMs: number;
  private readonly cap: number;
  private readonly sampleSize: number;
  private current: DigestDraft;
  private readonly ready: DigestDraft[] = [];

  constructor(
    policy: AlertPolicy,
    private readonly now: () => number = Date.now,
  ) {
    this.windowMs = policy.rateLimit.windowSeconds * 1_000;
    this.cap = policy.rateLimit.deliveriesPerMinute;
    this.sampleSize = policy.rateLimit.digestSampleSize;
    this.current = emptyDraft(this.windowStartAt(this.now()));
  }

  private windowStartAt(atMs: number): number {
    return Math.floor(atMs / this.windowMs) * this.windowMs;
  }

  private roll(): void {
    const start = this.windowStartAt(this.now());
    if (start === this.current.windowStart) return;
    if (this.current.suppressed > 0) this.ready.push(this.current);
    this.current = emptyDraft(start);
  }

  /** `true` when the alert may be delivered live; `false` when it is folded into the digest. */
  admit(alert: Pick<AlertRecord, 'id' | 'severity' | 'category' | 'cameraId'>): boolean {
    this.roll();
    if (this.current.delivered < this.cap) {
      this.current.delivered += 1;
      return true;
    }
    this.current.suppressed += 1;
    bump(this.current.bySeverity, alert.severity);
    bump(this.current.byCategory, alert.category);
    bump(this.current.byCamera, alert.cameraId);
    if (this.current.sample.length < this.sampleSize) this.current.sample.push(alert.id);
    return false;
  }

  /** Windows that have closed with suppression in them, plus the current one when `all`. */
  private drain(all: boolean): DigestDraft[] {
    this.roll();
    const out = this.ready.splice(0, this.ready.length);
    if (all && this.current.suppressed > 0) {
      out.push(this.current);
      this.current = emptyDraft(this.windowStartAt(this.now()));
    }
    return out;
  }

  /**
   * Persists every completed digest and returns them.
   *
   * `flushCurrent` closes the in-flight window too — what a benchmark or a shutdown wants, and what
   * a long-running consumer must not do on every batch, or a digest would be written per batch
   * instead of per minute.
   */
  async flush(db: DbLike, flushCurrent = false): Promise<AlertDigest[]> {
    const drafts = this.drain(flushCurrent);
    const written: AlertDigest[] = [];

    for (const draft of drafts) {
      const windowStart = new Date(draft.windowStart).toISOString();
      const windowEnd = new Date(draft.windowStart + this.windowMs).toISOString();
      const rows = await db.execute<{
        id: string;
        window_start: string;
        window_end: string;
        suppressed_count: number;
        delivered_count: number;
      }>(sql`
        insert into alert_digests (
          window_start, window_end, suppressed_count, delivered_count,
          by_severity, by_category, by_camera, sample
        ) values (
          ${windowStart}, ${windowEnd}, ${draft.suppressed}, ${draft.delivered},
          ${JSON.stringify(draft.bySeverity)}::jsonb,
          ${JSON.stringify(draft.byCategory)}::jsonb,
          ${JSON.stringify(draft.byCamera)}::jsonb,
          ${JSON.stringify(draft.sample)}::jsonb
        )
        on conflict (window_start) do update set
          suppressed_count = alert_digests.suppressed_count + excluded.suppressed_count,
          delivered_count  = alert_digests.delivered_count  + excluded.delivered_count,
          by_severity = excluded.by_severity,
          by_category = excluded.by_category,
          by_camera   = excluded.by_camera,
          sample      = excluded.sample
        returning id, window_start, window_end, suppressed_count, delivered_count
      `);
      const row = rows[0];
      if (row === undefined) continue;
      written.push({
        id: row.id,
        windowStart: new Date(row.window_start).toISOString(),
        windowEnd: new Date(row.window_end).toISOString(),
        suppressedCount: Number(row.suppressed_count),
        deliveredCount: Number(row.delivered_count),
        bySeverity: draft.bySeverity,
        byCategory: draft.byCategory,
        byCamera: draft.byCamera,
        sample: draft.sample,
      });
    }
    return written;
  }

  /** Live counters, for a benchmark or an observability endpoint. */
  stats(): { windowStart: string; delivered: number; suppressed: number; cap: number } {
    return {
      windowStart: new Date(this.current.windowStart).toISOString(),
      delivered: this.current.delivered,
      suppressed: this.current.suppressed + this.ready.reduce((n, d) => n + d.suppressed, 0),
      cap: this.cap,
    };
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/* Correlation                                                                                     */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * One plate read offered to the engine.
 *
 * `rawText` rather than a normalised string: D2-01's handoff is emphatic that `plate_reads.raw_text`
 * is *a string a camera produced, not a registration*, and normalisation plus grammar validation is
 * D2-03's job. Passing the raw text through means the engine cannot be handed a string that skipped
 * the validation — which is exactly how `757508300` would otherwise reach a lookup.
 */
export interface PlateReadCandidate {
  sightingId: string;
  /** ISO 8601, PTS-derived. The instant validity windows are evaluated at. */
  sightingTs: string;
  /** `cameras.id`, not the external id. */
  cameraId: string;
  rawText: string;
  confidence: number;
  cropUri?: string | null;
  isBestShot?: boolean;
}

export type CorrelationSkipReason =
  | 'below_confidence_floor'
  | 'unresolvable_normalisation'
  | 'no_watchlist_hit'
  | 'unknown_camera'
  | 'unknown_sighting';

export interface CorrelationOutcome {
  candidate: PlateReadCandidate;
  /** Alerts created or updated by this read, in the order the registry ranked the hits. */
  alerts: AlertRecord[];
  created: number;
  deduped: number;
  /** Set when no alert was produced. */
  skipped: CorrelationSkipReason | null;
  /** `true` when the read was refused a fuzzy search because D2-03 called it structurally non-plate. */
  fuzzyRefused: boolean;
  evaluation: PlateReadEvaluation;
}

interface CameraContext {
  id: string;
  externalId: string;
  name: string;
  district: string | null;
  trustScore: number | null;
  lat: number | null;
  lon: number | null;
}

interface SightingContext {
  id: string;
  ts: string;
  framePtsMs: number;
  trackId: number;
  vehicleClass: string;
  cropUri: string | null;
  isBestShot: boolean;
}

/** Postgres NOTIFY channel carrying `{type,id,deduped}` for cross-process stream fan-out. */
export const ALERT_NOTIFY_CHANNEL = 'saakshi_alerts';

export const DISCLAIMER =
  'MOCK PROVIDERS — SAAKSHI has no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity. ' +
  'This match is against the representative watchlist database this project ships. No biometric ' +
  'data is processed and no face recognition is performed anywhere in SAAKSHI.';

export interface AlertEngineOptions {
  db: Db;
  registry: WatchlistRegistry;
  policy?: AlertPolicy;
  bus?: AlertBus;
  /** `null` disables signed crop URLs explicitly; omitted reads the environment. */
  evidence?: EvidenceStore | null;
  now?: () => number;
}

export class AlertEngine {
  readonly policy: AlertPolicy;
  readonly bus: AlertBus;
  readonly gate: DeliveryGate;

  private readonly db: Db;
  private readonly registry: WatchlistRegistry;
  private readonly evidence: EvidenceStore | null;
  /**
   * The same guard the trace path uses (D2-11). Never `presignGet` directly: a `crop_uri` that is
   * not an object in *this* bucket must yield `null`, not a signed link that 400s.
   */
  private readonly presignCrop: CropPresigner;
  private readonly cameras = new Map<string, CameraContext>();

  constructor(options: AlertEngineOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.policy = options.policy ?? loadAlertPolicy();
    this.bus = options.bus ?? new AlertBus();
    this.evidence = options.evidence === undefined ? evidenceStoreFromEnv() : options.evidence;
    this.presignCrop = presignerFor(this.evidence, this.policy.evidence.cropUrlExpiresInS);
    this.gate = new DeliveryGate(this.policy, options.now ?? Date.now);
  }

  /* ── one read ──────────────────────────────────────────────────────────────────────────────── */

  async correlate(candidate: PlateReadCandidate): Promise<CorrelationOutcome> {
    const evaluation = evaluatePlateRead(candidate.rawText, candidate.confidence);
    const base: Omit<CorrelationOutcome, 'skipped'> = {
      candidate,
      alerts: [],
      created: 0,
      deduped: 0,
      fuzzyRefused: false,
      evaluation,
    };

    if (candidate.confidence < this.policy.correlation.minPlateConfidence) {
      return { ...base, skipped: 'below_confidence_floor' };
    }
    if (evaluation.normalizedText === '') {
      return { ...base, skipped: 'unresolvable_normalisation' };
    }

    // A read D2-03 classifies as structurally non-plate gets maxDistance 0, which the provider
    // contract defines as "fuzzy matching disabled". Fuzzy-expanding a phone number invents
    // neighbours that were never on any vehicle; exact equality against a watchlist string is still
    // a fact, and the `ungrammatical-read` ceiling is what keeps that fact at `low`.
    const refusalCodes = new Set(this.policy.correlation.fuzzyRefusalCodes);
    const fuzzyRefused = evaluation.reasons.some((r) => refusalCodes.has(r.code));
    const maxDistance = fuzzyRefused ? 0 : this.policy.correlation.maxDistance;

    const at = new Date(candidate.sightingTs);
    // `at: the sighting's timestamp`, never the default `now` — D2-05's handoff. Replaying yesterday
    // against `now` silently drops every entry whose window has since closed, and "would this have
    // matched at the time of the sighting" is the only fair question to ask of the person listed.
    const hits = await this.registry.lookupVehicle(evaluation.normalizedText, {
      at,
      maxDistance,
      limit: this.policy.correlation.limit,
    });

    if (hits.length === 0) {
      return { ...base, fuzzyRefused, skipped: 'no_watchlist_hit' };
    }

    const camera = await this.camera(candidate.cameraId);
    if (camera === null) return { ...base, fuzzyRefused, skipped: 'unknown_camera' };

    const sighting = await this.sighting(candidate);
    if (sighting === null) return { ...base, fuzzyRefused, skipped: 'unknown_sighting' };

    const outcome: CorrelationOutcome = { ...base, fuzzyRefused, skipped: null };
    for (const hit of hits) {
      const { alert, created } = await this.raise(hit, candidate, evaluation, camera, sighting);
      outcome.alerts.push(alert);
      if (created) outcome.created += 1;
      else outcome.deduped += 1;
      const deliver = this.gate.admit(alert);
      if (deliver) {
        this.bus.publish({ type: 'alert', alert, deduped: !created });
        // Cross-process fan-out. The API may be several replicas while the consumer is its own
        // process, so a bus that only reached this process would leave every operator's stream
        // empty in exactly the deployment the sizing calls for. Ids only — NOTIFY's payload is
        // capped at 8000 bytes and a why-payload is far larger than that.
        await this.notify({ type: 'alert', id: alert.id, deduped: !created });
      }
    }
    return outcome;
  }

  /* ── a batch ───────────────────────────────────────────────────────────────────────────────── */

  /**
   * Correlates a batch and writes the batch-level watchlist audit row.
   *
   * One audit row per batch rather than per plate read: `writeAudit` reads the chain tip and appends,
   * which serialises, and one chain write per read would make the audit log longer than the data it
   * describes while turning ingest into a single-file queue. The *decision* — an alert raised — is
   * audited individually, which is what a review actually asks about.
   */
  async correlateBatch(
    candidates: PlateReadCandidate[],
    principal?: Principal,
  ): Promise<CorrelationOutcome[]> {
    if (candidates.length === 0) return [];
    const outcomes: CorrelationOutcome[] = [];
    for (const candidate of candidates) outcomes.push(await this.correlate(candidate));

    const alerts = outcomes.reduce((n, o) => n + o.alerts.length, 0);
    await writeAudit(this.db, principal, {
      action: 'watchlist.lookup.auto',
      targetType: 'watchlist',
      targetId: null,
      purpose:
        'automated watchlist correlation of plate reads arriving from the analytics pipeline (D2-06)',
      params: {
        plateReads: candidates.length,
        maxDistance: this.policy.correlation.maxDistance,
        policyVersion: this.policy.version,
        fuzzyRefused: outcomes.filter((o) => o.fuzzyRefused).length,
      },
      resultCount: alerts,
    });

    const digests = await this.gate.flush(this.db);
    for (const digest of digests) {
      this.bus.publish({ type: 'digest', digest });
      await this.notify({ type: 'digest', id: digest.id, deduped: false });
    }

    return outcomes;
  }

  /* ── raising one alert ─────────────────────────────────────────────────────────────────────── */

  private async raise(
    hit: WatchlistHit,
    candidate: PlateReadCandidate,
    evaluation: PlateReadEvaluation,
    camera: CameraContext,
    sighting: SightingContext,
  ): Promise<{ alert: AlertRecord; created: boolean }> {
    const identification = this.identificationFor(hit, evaluation, candidate);
    const severity = severityFor(this.policy, {
      category: hit.category,
      entrySeverity: hit.severity,
      matchType: hit.matchType,
      validity: evaluation.validity,
      combinedConfidence: identification.combinedConfidence,
    });

    const reason = this.reasonFor(hit, identification, severity, camera, sighting);
    const dedupeKey = `${hit.entryId}:${camera.id}`;
    const windowMs = this.policy.dedupe.windowMinutes * 60_000;
    const tsMs = Date.parse(sighting.ts);
    const windowStart = new Date(Math.floor(tsMs / windowMs) * windowMs).toISOString();

    const row = await this.upsert({
      hit,
      camera,
      sighting,
      severity: severity.final,
      confidence: identification.combinedConfidence,
      reason,
      dedupeKey,
      windowStart,
      windowMs,
      observedPlate: identification.correctedPlate,
    });

    const alert: AlertRecord = {
      id: row.id,
      watchlistEntryId: hit.entryId,
      sightingId: row.sighting_id,
      cameraId: camera.id,
      ts: new Date(row.ts).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      sightingCount: Number(row.sighting_count),
      lastObservedPlate: row.last_observed_plate,
      category: hit.category,
      sourceSystem: hit.sourceSystem,
      severity: row.severity,
      matchType: row.match_type,
      matchDistance: Number(row.match_distance),
      confidence: Number(row.confidence),
      reason: row.reason,
      dedupeKey,
      dedupeWindowStart: new Date(row.dedupe_window_start).toISOString(),
      status: row.status,
      ackedBy: row.acked_by,
      ackedAt: row.acked_at === null ? null : new Date(row.acked_at).toISOString(),
      statusChangedBy: row.status_changed_by,
      statusChangedAt:
        row.status_changed_at === null ? null : new Date(row.status_changed_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    };

    if (row.created) {
      await writeAudit(this.db, undefined, {
        action: 'alert.raise',
        targetType: 'alert',
        targetId: alert.id,
        purpose: `watchlist ${hit.category} match on ${camera.externalId} (${hit.matchType})`,
        params: {
          watchlistEntryId: hit.entryId,
          matchType: hit.matchType,
          matchDistance: hit.matchDistance,
          severity: alert.severity,
          ceilingsApplied: severity.ceilingsApplied,
          observedPlate: identification.correctedPlate,
          policyVersion: this.policy.version,
        },
        resultCount: 1,
      });
    }

    return { alert, created: row.created };
  }

  /**
   * Insert-or-bump, with a **sliding** window probe in front of the unique index.
   *
   * The index is `(dedupe_key, dedupe_window_start)`, which alone gives *tumbling* windows: twenty
   * sightings spanning 09:59-10:04 straddle a boundary and produce two alerts, which is precisely
   * the acceptance criterion failing. So the first move is a sliding probe — "is there an alert on
   * this key whose last sighting is inside the window?" — and the unique index stays as the backstop
   * that makes a concurrent writer harmless rather than as the whole mechanism.
   *
   * A **dismissed** alert still accumulates. That a vehicle an operator dismissed came back twelve
   * more times is exactly what a supervisor needs to see, and raising a second alert somebody has
   * already judged is the fatigue this ticket exists to prevent.
   */
  private async upsert(input: {
    hit: WatchlistHit;
    camera: CameraContext;
    sighting: SightingContext;
    severity: AlertSeverity;
    confidence: number;
    reason: AlertReason;
    dedupeKey: string;
    windowStart: string;
    windowMs: number;
    observedPlate: string;
  }): Promise<AlertRow> {
    const { hit, camera, sighting } = input;
    const windowInterval = `${String(Math.round(input.windowMs / 1000))} seconds`;

    const bumped = await this.db.execute<AlertRow>(sql`
      update alerts set
        sighting_count      = alerts.sighting_count + 1,
        last_seen_at        = greatest(alerts.last_seen_at, ${sighting.ts}::timestamptz),
        last_sighting_id    = ${sighting.id},
        last_sighting_ts    = ${sighting.ts},
        last_observed_plate = ${input.observedPlate}
      where alerts.id = (
        select id from alerts
         where dedupe_key = ${input.dedupeKey}
           and last_seen_at >= ${sighting.ts}::timestamptz - ${windowInterval}::interval
           and last_seen_at <= ${sighting.ts}::timestamptz + ${windowInterval}::interval
         order by last_seen_at desc
         limit 1
      )
      returning *, false as created
    `);
    const existing = bumped[0];
    if (existing !== undefined) return existing;

    const inserted = await this.db.execute<AlertRow>(sql`
      insert into alerts (
        watchlist_entry_id, sighting_id, sighting_ts, camera_id, ts,
        match_type, match_distance, confidence, severity, reason,
        dedupe_key, dedupe_window_start,
        last_seen_at, last_sighting_id, last_sighting_ts, sighting_count, last_observed_plate
      ) values (
        ${hit.entryId}, ${sighting.id}, ${sighting.ts}, ${camera.id}, ${sighting.ts},
        ${hit.matchType}, ${hit.matchDistance}, ${input.confidence}, ${input.severity},
        ${JSON.stringify(input.reason)}::jsonb,
        ${input.dedupeKey}, ${input.windowStart},
        ${sighting.ts}, ${sighting.id}, ${sighting.ts}, 1, ${input.observedPlate}
      )
      on conflict (dedupe_key, dedupe_window_start) do update set
        sighting_count      = alerts.sighting_count + 1,
        last_seen_at        = greatest(alerts.last_seen_at, excluded.last_seen_at),
        last_sighting_id    = excluded.last_sighting_id,
        last_sighting_ts    = excluded.last_sighting_ts,
        last_observed_plate = excluded.last_observed_plate
      returning *, (xmax = 0) as created
    `);
    const row = inserted[0];
    if (row === undefined) throw new Error('alert upsert returned no row');
    return row;
  }

  /* ── the why-payload ───────────────────────────────────────────────────────────────────────── */

  private identificationFor(
    hit: WatchlistHit,
    evaluation: PlateReadEvaluation,
    candidate: PlateReadCandidate,
  ): AlertIdentification {
    const plateConfidence = Math.min(1, Math.max(0, candidate.confidence));
    const combined = Math.round(evaluation.adjustedConfidence * hit.matchConfidence * 1e6) / 1e6;
    return {
      observedPlate: evaluation.rawNormalizedText,
      correctedPlate: evaluation.normalizedText,
      watchlistValue: hit.plateNormalized ?? hit.personRef ?? '',
      validity: evaluation.validity,
      grammarValid: evaluation.grammarValid,
      grammarCorrected: evaluation.grammarCorrected,
      rejectionCodes: evaluation.reasons.map((r) => r.code),
      missingChars: evaluation.missingChars,
      completeness: evaluation.completeness,
      plateConfidence,
      adjustedPlateConfidence: evaluation.adjustedConfidence,
      matchConfidence: hit.matchConfidence,
      combinedConfidence: combined,
      strength: identificationStrength(combined, hit.matchType, evaluation.grammarValid),
    };
  }

  private reasonFor(
    hit: WatchlistHit,
    identification: AlertIdentification,
    severity: SeverityOutcome,
    camera: CameraContext,
    sighting: SightingContext,
  ): AlertReason {
    const cropUri = sighting.cropUri;
    const cropUrl = cropUri === null ? null : this.presignCrop(cropUri);

    const caveats: string[] = [];

    // Never empty, and the mock-provider line is always first: the one claim that must never be
    // implied is that a live registry answered.
    caveats.push(
      `Matched against SAAKSHI's representative watchlist (${hit.providerSystem} connector, mock). ` +
        'No live registry was consulted.',
    );

    if (hit.matchType === 'fuzzy') {
      caveats.push(
        `FUZZY MATCH — the read '${identification.correctedPlate}' is not identical to the ` +
          `watchlist plate '${identification.watchlistValue}'. Weighted edit distance ` +
          `${hit.matchDistance.toFixed(2)} under config/plate-confusions.json. ` +
          'This is a ranked possibility, not an identification.',
      );
    }
    if (identification.validity === 'partial') {
      const short = identification.missingChars;
      caveats.push(
        'The read is a PARTIAL registration' +
          (short === null ? '' : ` — ${String(short)} character(s) short of a complete plate`) +
          '. More than one vehicle can carry this prefix.',
      );
    }
    if (identification.validity === 'invalid') {
      caveats.push(
        'The read is NOT a valid Indian registration under any layout ' +
          `(${identification.rejectionCodes.join(', ')}). It identifies no vehicle on its own. ` +
          "The estate's highest-confidence read of the live run was a hoarding's phone number.",
      );
    }
    if (identification.grammarCorrected) {
      caveats.push(
        `Characters were corrected before matching: '${identification.observedPlate}' → ` +
          `'${identification.correctedPlate}' (D2-03 slot-aware correction).`,
      );
    }
    if (severity.ceilingsApplied.length > 0) {
      caveats.push(
        `Severity was lowered from ${severity.fromCategory} to ${severity.final} by: ` +
          `${severity.ceilingsApplied.join(', ')}.`,
      );
    }
    if (camera.trustScore === null) caveats.push('never probed — no trust score for this camera.');
    else if (camera.trustScore < 40) {
      caveats.push(
        `Camera trust score ${camera.trustScore.toFixed(1)}/100 (untrusted band) — treat this ` +
          'reading with corresponding caution.',
      );
    }
    if (camera.lat === null || camera.lon === null) {
      caveats.push('no location on file for this camera — it cannot be placed on the map.');
    }
    if (cropUrl === null) {
      // Three distinct reasons, and they must stay distinguishable (D2-11): "no crop was taken",
      // "there is no store to sign against", and "there is a crop URI but it is not an object in
      // this bucket". The third is what a `file://` crop from D2-01's local store looks like, and
      // conflating it with the second is how a reader concludes MinIO is down when it is not.
      caveats.push(
        cropUri === null
          ? 'no crop URL — no crop was stored for this sighting; only about 1 sighting in 30 is a best shot.'
          : this.evidence === null
            ? 'no crop URL — no evidence store is configured, so the crop cannot be signed for viewing.'
            : `no crop URL — the stored crop URI is not an object in this evidence store ` +
              `(${uriScheme(cropUri)}), so it cannot be signed. A link that cannot be served is ` +
              'never emitted.',
      );
    }
    if (!sighting.isBestShot) {
      caveats.push('this sighting is not the track’s best shot; a clearer crop may exist.');
    }

    const noteValue = hit.meta['note'];

    return {
      matchType: hit.matchType,
      matchDistance: hit.matchDistance,
      explanation: hit.matchExplanation,
      identification,
      severityBasis: {
        fromCategory: severity.fromCategory,
        fromEntry: severity.fromEntry,
        ceilingsApplied: severity.ceilingsApplied,
        final: severity.final,
        categoryRank: severity.categoryRank,
      },
      camera: {
        id: camera.id,
        externalId: camera.externalId,
        name: camera.name,
        location:
          camera.lat === null || camera.lon === null ? null : { lat: camera.lat, lon: camera.lon },
        district: camera.district,
        trustScore: camera.trustScore,
      },
      sighting: {
        id: sighting.id,
        ts: new Date(sighting.ts).toISOString(),
        framePtsMs: sighting.framePtsMs,
        trackId: sighting.trackId,
        vehicleClass: sighting.vehicleClass,
      },
      evidence: {
        cropUri,
        cropUrl,
        cropUrlExpiresInS: this.policy.evidence.cropUrlExpiresInS,
        isBestShot: sighting.isBestShot,
      },
      watchlistRecord: {
        entryId: hit.entryId,
        category: hit.category,
        entityType: hit.entityType,
        plateNormalized: hit.plateNormalized,
        personRef: hit.personRef,
        sourceSystem: hit.sourceSystem,
        sourceRef: hit.sourceRef,
        providerSystem: hit.providerSystem,
        live: false,
        entrySeverity: hit.severity,
        validFrom: hit.validFrom,
        validTo: hit.validTo,
        note: typeof noteValue === 'string' ? noteValue : null,
      },
      caveats,
      disclaimer: DISCLAIMER,
      policyVersion: this.policy.version,
    };
  }

  /** Best-effort NOTIFY. A failed fan-out must never fail an alert that is already persisted. */
  private async notify(payload: {
    type: 'alert' | 'digest';
    id: string;
    deduped: boolean;
  }): Promise<void> {
    try {
      await this.db.execute(
        sql`select pg_notify(${ALERT_NOTIFY_CHANNEL}, ${JSON.stringify(payload)})`,
      );
    } catch {
      // The row is in `alerts`; the stream is a live view of it, not the record of it.
    }
  }

  /* ── context lookups ───────────────────────────────────────────────────────────────────────── */

  private async camera(id: string): Promise<CameraContext | null> {
    const cached = this.cameras.get(id);
    if (cached !== undefined) return cached;
    const rows = await this.db.execute<{
      id: string;
      external_id: string;
      name: string;
      district: string | null;
      trust_score: string | null;
      lat: number | null;
      lon: number | null;
    }>(sql`
      select id::text as id, external_id, name, district, trust_score::text as trust_score,
             case when location is null then null else st_y(location::geometry) end as lat,
             case when location is null then null else st_x(location::geometry) end as lon
        from cameras where id = ${id}::uuid
    `);
    const row = rows[0];
    if (row === undefined) return null;
    const context: CameraContext = {
      id: row.id,
      externalId: row.external_id,
      name: row.name,
      district: row.district,
      // NULL means never probed, which is not the same as scored zero (D1-05 / D1-06).
      trustScore: row.trust_score === null ? null : Number(row.trust_score),
      lat: row.lat === null ? null : Number(row.lat),
      lon: row.lon === null ? null : Number(row.lon),
    };
    this.cameras.set(id, context);
    return context;
  }

  /**
   * The sighting behind the read, and the crop it should show.
   *
   * `crop_uri` is joined from the track session's **best shot** rather than taken from whatever
   * sighting happened to carry the read: D2-02 measured `is_best_shot` true for roughly 1 sighting
   * in 30, so an alert built on an arbitrary sighting usually finds `crop_uri IS NULL`. `track_id`
   * is session-qualified (`session * 100_000 + tracker_id`), so `(camera_id, track_id)` is one
   * vehicle appearance — the raw tracker id is reused across a loop-point cut and must never be
   * matched on.
   */
  private async sighting(candidate: PlateReadCandidate): Promise<SightingContext | null> {
    const rows = await this.db.execute<{
      id: string;
      ts: string;
      frame_pts_ms: string;
      track_id: number;
      class: string;
      crop_uri: string | null;
      is_best_shot: boolean;
      best_crop_uri: string | null;
    }>(sql`
      select s.id::text as id, s.ts, s.frame_pts_ms::text as frame_pts_ms, s.track_id,
             s.class, s.crop_uri, s.is_best_shot,
             (select b.crop_uri from sightings b
               where b.camera_id = s.camera_id and b.track_id = s.track_id
                 and b.is_best_shot and b.crop_uri is not null
               order by b.ts limit 1) as best_crop_uri
        from sightings s
       where s.id = ${candidate.sightingId}::uuid and s.ts = ${candidate.sightingTs}
       limit 1
    `);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      ts: row.ts,
      framePtsMs: Number(row.frame_pts_ms),
      trackId: row.track_id,
      vehicleClass: row.class,
      cropUri: candidate.cropUri ?? row.crop_uri ?? row.best_crop_uri,
      isBestShot: candidate.isBestShot ?? row.is_best_shot,
    };
  }
}

interface AlertRow {
  /** `db.execute` requires an index signature on its row type. */
  [column: string]: unknown;
  id: string;
  watchlist_entry_id: string;
  sighting_id: string;
  sighting_ts: string;
  camera_id: string;
  ts: string;
  match_type: 'exact' | 'fuzzy';
  match_distance: string;
  confidence: string;
  severity: AlertSeverity;
  reason: AlertReason;
  dedupe_key: string;
  dedupe_window_start: string;
  last_seen_at: string;
  last_sighting_id: string | null;
  last_sighting_ts: string | null;
  sighting_count: number;
  last_observed_plate: string | null;
  status: AlertStatus;
  acked_by: string | null;
  acked_at: string | null;
  status_changed_at: string | null;
  status_changed_by: string | null;
  created_at: string;
  created: boolean;
  /**
   * The crop URI as it stands **now** on the alert's latest sighting, not as it stood the
   * millisecond the alert was raised (D2-11). Selected by `SELECT_ALERT`; absent on rows built
   * elsewhere, in which case the stored reason's own `cropUri` is used unchanged.
   */
  current_crop_uri?: string | null;
  /**
   * `cameras.retention_days` for the alert's camera (D3-05). `null` means the owning department
   * declared none — the normal case on this estate, and `unknown` rather than any default. Absent
   * on rows built elsewhere than `SELECT_ALERT`, which is why it is optional.
   */
  camera_retention_days?: number | null;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/* Lifecycle                                                                                       */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

export class AlertTransitionError extends Error {
  constructor(
    readonly from: AlertStatus,
    readonly to: AlertStatus,
  ) {
    super(
      `alert cannot go from '${from}' to '${to}' — permitted: ` +
        `${ALERT_TRANSITIONS[from].length === 0 ? '(terminal)' : ALERT_TRANSITIONS[from].join(', ')}`,
    );
    this.name = 'AlertTransitionError';
  }
}

export class AlertNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`no alert ${id}`);
    this.name = 'AlertNotFoundError';
  }
}

/**
 * Moves one alert through the lifecycle, refusing anything the graph forbids, and audits it.
 *
 * The whole thing runs in one transaction with the audit write, for the reason `writeAudit` states:
 * a mutation without its audit row is the thing the table exists to prevent. The status check is a
 * `SELECT … FOR UPDATE` inside that transaction rather than a read-then-write, because two officers
 * clicking ack and dismiss at the same instant is a real control-room event, not a theoretical one.
 */
export async function transitionAlert(
  db: Db,
  id: string,
  to: AlertStatus,
  principal: Principal,
  note?: string,
): Promise<AlertRecord> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ id: string; status: AlertStatus }>(
      sql`select id::text as id, status from alerts where id = ${id}::uuid for update`,
    );
    const current = locked[0];
    if (current === undefined) throw new AlertNotFoundError(id);
    if (!canTransition(current.status, to)) throw new AlertTransitionError(current.status, to);

    const isAck = to === 'ack';
    const updated = await tx.execute<AlertRow>(sql`
      update alerts set
        status            = ${to},
        status_changed_at = now(),
        status_changed_by = ${principal.sub}::uuid,
        acked_by          = ${isAck ? sql`${principal.sub}::uuid` : sql`alerts.acked_by`},
        acked_at          = ${isAck ? sql`now()` : sql`alerts.acked_at`}
      where id = ${id}::uuid
      returning *, false as created
    `);
    const row = updated[0];
    if (row === undefined) throw new AlertNotFoundError(id);

    await writeAudit(tx, principal, {
      action: `alert.${to}`,
      targetType: 'alert',
      targetId: id,
      purpose: note ?? `alert moved from '${current.status}' to '${to}' by ${principal.badgeNo}`,
      params: { from: current.status, to, badgeNo: principal.badgeNo },
      resultCount: 1,
    });

    return rowToRecord(row);
  });
}

/** Shared row → wire mapping, so the routes and the engine cannot describe an alert differently. */
/** A caveat that exists only to explain a missing crop. Dropped once the crop is there (D2-11). */
const NO_CROP_CAVEAT = 'no crop URL';

/**
 * The why-payload with its crop link minted **now** (D2-11).
 *
 * D2-02's rule is that a signed URL is never persisted, because it is a credential with an expiry
 * and a stored one is dead by the time anyone opens it. The alert path persisted one anyway: the
 * whole `reason` object is written to `alerts.reason` at correlation time, signed URL included. Two
 * consequences, and both are the failure this ticket exists to remove —
 *
 * 1. **It expires.** A queue opened sixteen minutes after the alert served a link that 403s.
 * 2. **It is signed too early to be right.** The plate crop travels on the `evidence` stream and is
 *    uploaded by a different process; at correlation time nothing has been uploaded yet, so the
 *    stored `cropUri` is the worker's `file://` path and the honest answer at that instant is
 *    `null`. The object lands seconds later and the alert would carry that `null` forever.
 *
 * So the URI is re-read from the sighting (`current_crop_uri`) and the URL re-minted on every read.
 * The stored `cropUri` remains the fallback for a row selected without it.
 */
function reasonWithCurrentCrop(row: AlertRow, presign: CropPresigner): AlertReason {
  const stored = row.reason.evidence;
  const current = typeof row.current_crop_uri === 'string' ? row.current_crop_uri : null;
  const cropUri = current ?? stored.cropUri;
  const cropUrl = cropUri === null ? null : presign(cropUri);
  if (cropUri === stored.cropUri && cropUrl === stored.cropUrl) return row.reason;
  return {
    ...row.reason,
    // A "no crop URL — …" caveat written when there was no crop would now be false. Every other
    // caveat is a statement about the *match* and stays exactly as it was recorded.
    caveats:
      cropUrl === null
        ? row.reason.caveats
        : row.reason.caveats.filter((c) => !c.startsWith(NO_CROP_CAVEAT)),
    evidence: { ...stored, cropUri, cropUrl },
  };
}

export function rowToRecord(row: AlertRow, presign?: CropPresigner): AlertRecord {
  const reason = presign === undefined ? row.reason : reasonWithCurrentCrop(row, presign);
  return {
    id: row.id,
    watchlistEntryId: row.watchlist_entry_id,
    sightingId: row.sighting_id,
    cameraId: row.camera_id,
    ts: new Date(row.ts).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    sightingCount: Number(row.sighting_count),
    lastObservedPlate: row.last_observed_plate,
    category: reason.watchlistRecord.category,
    sourceSystem: reason.watchlistRecord.sourceSystem,
    severity: row.severity,
    matchType: row.match_type,
    matchDistance: Number(row.match_distance),
    confidence: Number(row.confidence),
    reason,
    dedupeKey: row.dedupe_key,
    dedupeWindowStart: new Date(row.dedupe_window_start).toISOString(),
    status: row.status,
    ackedBy: row.acked_by,
    ackedAt: row.acked_at === null ? null : new Date(row.acked_at).toISOString(),
    statusChangedBy: row.status_changed_by,
    statusChangedAt:
      row.status_changed_at === null ? null : new Date(row.status_changed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export type { AlertRow };
