import { z } from 'zod';
import { AlertSeverity, WatchlistCategory } from '@saakshi/shared';
import {
  ProviderHealth,
  WatchlistEntityType,
  WatchlistHit,
  WatchlistMeta,
  WatchlistSystem,
} from '../watchlist/index.js';

/**
 * Wire contracts for the watchlist API.
 *
 * One set of zod schemas drives validation, serialisation and the OpenAPI document, so the spec
 * cannot describe something the server does not do — the same rule the registry API follows.
 */

export const WatchlistEntryResponse = z.object({
  id: z.uuid(),
  category: WatchlistCategory,
  entityType: WatchlistEntityType,
  plateNormalized: z.string().nullable(),
  personRef: z.string().nullable(),
  sourceSystem: WatchlistSystem,
  sourceRef: z.string().nullable(),
  severity: AlertSeverity,
  validFrom: z.string(),
  validTo: z.string().nullable(),
  active: z.boolean(),
  meta: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  /** Whether the entry's window is open *right now*. Computed, never stored. */
  valid: z.boolean(),
});
export type WatchlistEntryResponse = z.infer<typeof WatchlistEntryResponse>;

const plate = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .transform((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, ''));

export const WatchlistEntryCreate = z
  .object({
    category: WatchlistCategory,
    entityType: WatchlistEntityType,
    /** Normalised on the way in: uppercase, `A-Z0-9` only. */
    plate: plate.nullish(),
    personRef: z.string().trim().min(1).max(200).nullish(),
    sourceSystem: WatchlistSystem.default('manual'),
    sourceRef: z.string().trim().min(1).max(200).nullish(),
    severity: AlertSeverity.default('medium'),
    validFrom: z.iso.datetime().optional(),
    validTo: z.iso.datetime().nullish(),
    active: z.boolean().default(true),
    /** Per-system detail. Biometric keys are refused — see `BIOMETRIC_FIELD_DENYLIST`. */
    meta: WatchlistMeta.default({}),
  })
  .superRefine((body, ctx) => {
    if (body.entityType === 'vehicle' && (body.plate === null || body.plate === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['plate'], message: 'a vehicle entry needs a plate' });
    }
    if (body.entityType === 'person' && (body.personRef === null || body.personRef === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['personRef'],
        message: 'a person entry needs a personRef',
      });
    }
    if (
      body.validTo !== null &&
      body.validTo !== undefined &&
      body.validFrom !== undefined &&
      body.validTo <= body.validFrom
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['validTo'],
        message: 'validTo must be after validFrom',
      });
    }
  });
export type WatchlistEntryCreate = z.infer<typeof WatchlistEntryCreate>;

export const WatchlistEntryPatch = z.object({
  category: WatchlistCategory.optional(),
  plate: plate.nullish(),
  personRef: z.string().trim().min(1).max(200).nullish(),
  severity: AlertSeverity.optional(),
  validFrom: z.iso.datetime().optional(),
  validTo: z.iso.datetime().nullish(),
  active: z.boolean().optional(),
  meta: WatchlistMeta.optional(),
});
export type WatchlistEntryPatch = z.infer<typeof WatchlistEntryPatch>;

export const WatchlistListQuery = z.object({
  category: WatchlistCategory.optional(),
  entityType: WatchlistEntityType.optional(),
  sourceSystem: WatchlistSystem.optional(),
  /** `true` restricts to entries whose window is open now. Omitted returns both. */
  validNow: z.coerce.boolean().optional(),
  active: z.coerce.boolean().optional(),
  /** Prefix search over the normalised plate. */
  plate: z.string().trim().max(24).optional(),
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type WatchlistListQuery = z.infer<typeof WatchlistListQuery>;

/**
 * The purpose every lookup must state.
 *
 * **Required, not defaulted.** `audit_log.purpose` is the column that turns a surveillance system
 * into an accountable one, and a default value would make every row say the same thing — which is
 * the same as saying nothing. Eight characters is enough to stop `-` and short enough not to be an
 * obstacle in a control room.
 */
export const LookupQuery = z.object({
  purpose: z.string().trim().min(8).max(500),
  caseRef: z.string().trim().min(1).max(200).optional(),
  /**
   * Evaluate the validity window at this instant instead of now — how an alert is fairly reviewed
   * after the fact.
   */
  at: z.iso.datetime().optional(),
  /** `0` disables fuzzy matching. Default 2, the distance D2-01's truncation failures live at. */
  maxDistance: z.coerce.number().int().min(0).max(4).default(2),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type LookupQuery = z.infer<typeof LookupQuery>;

export const LookupResponse = z.object({
  query: z.string(),
  /** The normalised form actually matched on. */
  normalized: z.string(),
  at: z.string(),
  maxDistance: z.number(),
  hits: z.array(WatchlistHit),
  /**
   * Repeated on every response because a screenshot of one endpoint is what ends up in a deck.
   * No live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity exists.
   */
  disclaimer: z.string(),
});
export type LookupResponse = z.infer<typeof LookupResponse>;

export const ProvidersResponse = z.object({
  providers: z.array(ProviderHealth),
  disclaimer: z.string(),
});

export const WatchlistImportReport = z.object({
  received: z.number(),
  inserted: z.number(),
  updated: z.number(),
  rejected: z.array(z.object({ row: z.number(), field: z.string(), message: z.string() })),
  committed: z.boolean(),
});
export type WatchlistImportReport = z.infer<typeof WatchlistImportReport>;
