import { z } from 'zod';
import {
  AlertSeverity,
  SourceSystem,
  WatchlistCategory,
  normalise as normalisePlate,
} from '@saakshi/shared';

/**
 * The watchlist integration contract.
 *
 * **There is no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity, and this module never
 * pretends otherwise.** The challenge's problem statement says participants *"may create and use
 * their own representative watchlist database"*, so what ships is the *interface* each connector
 * would implement, a mock provider serving representative data, and a written specification of
 * exactly what Gujarat Police would have to provide (`docs/watchlist-integration.md`).
 *
 * `ProviderHealth.live` is `false` for every provider in this repository, and it is reported on the
 * API rather than left to a README, because the honest position has to be visible from the running
 * system — not only from documentation nobody opens during a demo.
 */

/** The systems a connector can be written against. Mirrors the `source_system` enum from D1-01. */
export const WatchlistSystem = SourceSystem;
export type WatchlistSystem = z.infer<typeof WatchlistSystem>;

export const WatchlistEntityType = z.enum(['vehicle', 'person']);
export type WatchlistEntityType = z.infer<typeof WatchlistEntityType>;

/**
 * Keys that must never appear in `watchlist_entries.meta`.
 *
 * SAAKSHI performs **no face recognition and processes no biometrics** (CLAUDE.md, PROJECT.md).
 * AFIS and NAFIS are reference-only systems here: an entry may carry the *reference* under which a
 * subject is held in those systems, and nothing else. That is a claim worth enforcing rather than
 * asserting — an unenforced "we don't store biometrics" survives exactly until the first person
 * pastes a face embedding into a free-form JSON column, and then the claim is false and nobody
 * knows. The importer, the CRUD contract and the mock provider all refuse these keys with a 400.
 *
 * Matching is case- and separator-insensitive: `faceEmbedding`, `face_embedding` and `FACE-EMBEDDING`
 * are one key.
 */
export const BIOMETRIC_FIELD_DENYLIST = [
  'faceembedding',
  'facetemplate',
  'faceimage',
  'facevector',
  'photo',
  'photograph',
  'mugshot',
  'fingerprint',
  'fingerprints',
  'minutiae',
  'iris',
  'iriscode',
  'iristemplate',
  'palmprint',
  'voiceprint',
  'dna',
  'biometric',
  'biometrics',
  'biometricdata',
  'gait',
  'retina',
] as const;

/** Normalises a meta key for denylist comparison: lowercase, separators stripped. */
export function canonicalMetaKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Every denylisted key present anywhere in a meta object, including nested objects and arrays. */
export function biometricKeysIn(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => biometricKeysIn(item, [...path, String(i)]));
  }
  if (value === null || typeof value !== 'object') return [];

  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = [...path, key];
    if ((BIOMETRIC_FIELD_DENYLIST as readonly string[]).includes(canonicalMetaKey(key))) {
      found.push(here.join('.'));
    }
    found.push(...biometricKeysIn(child, here));
  }
  return found;
}

/**
 * Free-form per-system detail, modelled on the real record shapes so a live integration is a
 * connector swap rather than a schema migration. Validated only for what it must *not* contain —
 * see `BIOMETRIC_FIELD_DENYLIST`. Field-by-field mappings are in `docs/watchlist-integration.md`.
 */
export const WatchlistMeta = z
  .record(z.string(), z.unknown())
  .refine((meta) => biometricKeysIn(meta).length === 0, {
    message:
      'biometric fields are refused: SAAKSHI processes no biometrics and performs no face recognition',
  });
export type WatchlistMeta = z.infer<typeof WatchlistMeta>;

/**
 * One matching watchlist entry, with the reason it matched.
 *
 * **This is the shape D2-06's alert engine consumes directly** (the ticket's stated handoff), so it
 * carries the match evidence rather than only the entry: an alert has to be verifiable in three
 * seconds and a bare entry id is not verifiable at all.
 */
export const WatchlistHit = z.object({
  entryId: z.uuid(),
  category: WatchlistCategory,
  entityType: WatchlistEntityType,

  /** Set for `entity_type = 'vehicle'`. Normalised: uppercase `A-Z0-9`, no separators. */
  plateNormalized: z.string().nullable(),
  /** Set for `entity_type = 'person'`. An opaque case reference — never biometric data. */
  personRef: z.string().nullable(),

  /** The system this record is *modelled on*. Never evidence of a live lookup. */
  sourceSystem: WatchlistSystem,
  sourceRef: z.string().nullable(),
  /** The provider that answered. Always a mock in this repository. */
  providerSystem: WatchlistSystem,
  /** `false` for every provider that ships here. Present so a demo cannot imply otherwise. */
  live: z.boolean(),

  severity: AlertSeverity,
  matchType: z.enum(['exact', 'fuzzy']),
  /**
   * Edit distance under the active matcher's metric. `0` for an exact match.
   *
   * **Not an integer.** `PlateMatcher.distance` was always declared `number`; the wire contract said
   * `.int()` because the only shipped metric was `levenshtein()`. D2-04's confusion-aware metric is
   * continuous — `GJ35U07 → GJ35U0779` is 0.70, not 2 — and under `.int()` the response failed
   * serialisation rather than rounding, which is the correct failure but the wrong constraint.
   */
  matchDistance: z.number().nonnegative(),
  /** Match strength in `[0,1]`. `1` for exact. Not OCR confidence — that is the caller's. */
  matchConfidence: z.number().min(0).max(1),
  /** Human-readable, for the alert's why-payload. */
  matchExplanation: z.string(),

  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
  meta: z.record(z.string(), z.unknown()),
});
export type WatchlistHit = z.infer<typeof WatchlistHit>;

export const SyncResult = z.object({
  system: WatchlistSystem,
  /** Rows the upstream offered. */
  fetched: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  /** Offered but not for this provider's system, or malformed. */
  skipped: z.number().int().nonnegative(),
  /** Echo of the `since` argument, so a caller can tell a full pull from an incremental one. */
  since: z.iso.datetime().nullable(),
  at: z.iso.datetime(),
});
export type SyncResult = z.infer<typeof SyncResult>;

export const ProviderHealth = z.object({
  system: WatchlistSystem,
  /**
   * **Always `false` here.** A live connector would set it true; nothing in this repository does,
   * and no screen, document or demo may present these providers as connected.
   */
  live: z.literal(false),
  /** `mock` for everything that ships. */
  mode: z.enum(['mock', 'live']),
  /** Whether the provider's own backing store answered. */
  reachable: z.boolean(),
  /** Entries this provider can currently serve. */
  entries: z.number().int().nonnegative(),
  /** Entries excluded right now because their validity window has closed or they are inactive. */
  inactiveEntries: z.number().int().nonnegative(),
  lastSyncAt: z.iso.datetime().nullable(),
  /** Why this provider is not live, in words a judge reads without opening the code. */
  note: z.string(),
});
export type ProviderHealth = z.infer<typeof ProviderHealth>;

export interface LookupOptions {
  /**
   * The instant the validity window is evaluated at. Defaults to now.
   *
   * Explicit rather than implicit because an alert is replayed during review: asking "would this
   * have matched at the time of the sighting?" is a different question from "does it match now",
   * and only one of them is fair to the person on the list.
   */
  at?: Date;
  /** Maximum edit distance for a fuzzy match. `0` disables fuzzy matching entirely. */
  maxDistance?: number;
  /** Hard cap on returned hits. */
  limit?: number;
}

/**
 * What every connector implements — VAHAN, SARTHI, eGujCop, AFIS, NAFIS, or a manual desk.
 *
 * A second provider is registered by implementing this and calling `WatchlistRegistry.register`.
 * Nothing in `packages/api/src/watchlist` needs to change to accept one, which is the property the
 * `null`-provider test exists to prove.
 */
export interface WatchlistProvider {
  readonly system: WatchlistSystem;
  lookupVehicle(plateNormalized: string, options?: LookupOptions): Promise<WatchlistHit[]>;
  lookupPerson(ref: string, options?: LookupOptions): Promise<WatchlistHit[]>;
  /** Bulk pull into `watchlist_entries`. */
  sync(since?: Date): Promise<SyncResult>;
  health(): Promise<ProviderHealth>;
}

/**
 * The normalised plate form this service keys on: uppercase, `A-Z0-9` only.
 *
 * **D2-03 now owns this.** Kept as a named delegating function so the watchlist module's call sites
 * read as intent ("normalise for lookup") rather than as an import detail, but the implementation is
 * the one shared function — `packages/shared/src/plate/normalise.ts` — so the worker, the API and
 * D2-04's fuzzy index cannot drift apart. A test in `packages/shared/src/plate/plate.test.ts`
 * asserts the two agree on every plate in `fixtures/watchlist-seed.csv`, so the 235 seeded rows need
 * no re-normalisation.
 *
 * A function declaration rather than `export const … = normalise`: `seed.ts` and this module import
 * each other, and a `const` binding is in its temporal dead zone when `seed.ts` runs.
 *
 * Grammar, slot-aware correction, `corrections[]` and `adjusted_confidence` live in
 * `@saakshi/shared`'s `validate()` / `evaluatePlateRead()`. This is only the total, idempotent,
 * never-throws reduction that makes two strings comparable.
 */
export function normaliseForLookup(raw: string): string {
  return normalisePlate(raw);
}
