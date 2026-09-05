/**
 * Wire contracts for the audit chain, and the two bindings every investigative endpoint carries.
 *
 * **Purpose binding.** A search of a citizen's movements with no stated reason is the thing this
 * system exists to make impossible, so `purpose` is a required query parameter on every search and
 * every trace, rejected server-side with a 400 when it is missing or blank. What the check can and
 * cannot do is worth being exact about: it proves a purpose was *stated and recorded against the
 * officer who stated it*, in an append-only chain. It cannot prove the purpose was *true*. That
 * distinction is the whole value of the mechanism — it moves an unaccountable query into a record
 * an auditor can read back and challenge — and overstating it in front of a forensic-sciences jury
 * would be worse than not having it.
 *
 * **Case binding.** An export additionally requires a case or FIR reference, because an export
 * leaves the system: once evidence is in someone's hands, "which case is this for" is no longer
 * answerable from the inside.
 */
import { z } from 'zod';

/**
 * Long enough to be a reason rather than a keystroke.
 *
 * Three characters is deliberately a low bar. The bar that matters is that something was recorded
 * and attributed; a length check cannot assess substance, and pretending it could would invite
 * exactly the false confidence the chain is meant to remove.
 */
export const PurposeStatement = z
  .string()
  .trim()
  .min(3, 'state a purpose for this search — it is recorded in the audit chain')
  .max(500);

/** `FIR/2026/00123`, `CR-118/2026`, and the other shapes a case number takes across districts. */
export const CaseReference = z
  .string()
  .trim()
  .min(3, 'an export must name the case or FIR it is for')
  .max(64)
  .regex(/^[A-Za-z0-9/\-_.]+$/, 'a case reference may contain letters, digits and / - _ . only');

/** Attached to every investigative querystring. `case_ref` is optional until something is exported. */
export const PurposeQuery = z.object({
  purpose: PurposeStatement,
  case_ref: CaseReference.optional(),
});

export const ChainEntryStatusSchema = z.enum(['ok', 'pre_canonical', 'hash_mismatch']);

export const AuditEntryResponse = z.object({
  id: z.string(),
  seq: z.number().int(),
  ts: z.string(),
  action: z.string(),
  actorId: z.string().nullable(),
  actorBadgeNo: z.string().nullable(),
  actorRole: z.string().nullable(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  purpose: z.string(),
  caseRef: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  resultCount: z.number().int().nullable(),
  hash: z.string(),
  prevHash: z.string(),
  status: ChainEntryStatusSchema,
});

export const AuditSearchQuery = z.object({
  actor_id: z.uuid().optional(),
  badge_no: z.string().trim().min(1).max(64).optional(),
  action: z.string().trim().min(1).max(64).optional(),
  case_ref: z.string().trim().min(1).max(64).optional(),
  target_type: z.string().trim().min(1).max(64).optional(),
  target_id: z.string().trim().min(1).max(200).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const AuditSearchResponse = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  entries: z.array(AuditEntryResponse),
  /** What the chain viewer is allowed to claim. Rendered, never inferred by the client. */
  disclaimer: z.string(),
});

export const ChainBreakResponse = z.object({
  reason: z.enum(['hash_mismatch', 'link_mismatch', 'epoch_mismatch', 'unsealed_prologue']),
  position: z.number().int(),
  expected: z.string(),
  actual: z.string(),
  detail: z.string(),
  entry: z.object({
    id: z.string(),
    seq: z.number().int(),
    ts: z.string(),
    action: z.string(),
    actorId: z.string().nullable(),
    actorBadgeNo: z.string().nullable(),
    actorRole: z.string().nullable(),
    targetType: z.string(),
    targetId: z.string().nullable(),
    caseRef: z.string().nullable(),
    hash: z.string(),
    prevHash: z.string(),
  }),
});

export const ChainVerificationResponse = z.object({
  ok: z.boolean(),
  algorithm: z.string(),
  checkedAt: z.string(),
  entries: z.number().int(),
  preCanonicalEntries: z.number().int(),
  verifiedEntries: z.number().int(),
  epochSealed: z.boolean(),
  genesisHash: z.string(),
  tipHash: z.string().nullable(),
  forks: z.array(z.object({ prevHash: z.string(), entryIds: z.array(z.string()) })),
  firstBreak: ChainBreakResponse.nullable(),
  /** States what a passing verification does and does not prove. */
  claim: z.string(),
});

export const ExportBundleRequest = z.object({
  plate: z.string().trim().min(1).max(24),
  purpose: PurposeStatement,
  case_ref: CaseReference,
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

export const ExportBundleResponse = z.object({
  bundleId: z.string(),
  createdAt: z.string(),
  caseRef: z.string(),
  manifestHash: z.string(),
  items: z.number().int(),
  bytes: z.number().int(),
  path: z.string(),
  auditEntryHash: z.string(),
});
