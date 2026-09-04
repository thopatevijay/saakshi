import { createHash } from 'node:crypto';
import { auditLog } from '@saakshi/shared/db';
import { desc } from 'drizzle-orm';
import type { DbLike } from './db/client.js';
import type { Principal } from './auth.js';

/**
 * The audit chain's write path.
 *
 * D3-04 owns verification and export bundles. What lands here is the part that cannot be
 * retrofitted: if the rows are not written *now*, with their links, there is no chain to verify
 * later. `prev_hash` and `hash` are NOT NULL in the schema precisely so this cannot be deferred.
 *
 * `audit_log` is append-only in the database (grants plus BEFORE UPDATE/DELETE triggers), so a row
 * written here is final.
 */

/** First link. A chain has to start somewhere, and it should be recognisable when it does. */
export const GENESIS_HASH = 'genesis';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  /** Why this happened. Not optional — the schema enforces it, and so does the review. */
  purpose: string;
  caseRef?: string | null;
  params?: Record<string, unknown>;
  resultCount?: number | null;
}

/**
 * Canonical serialisation for hashing. Field order is fixed here rather than left to
 * `JSON.stringify` of an object literal, because a hash whose input order can drift is a hash that
 * will fail to verify for reasons nobody can reproduce.
 */
function digest(prevHash: string, entry: AuditEntry, actorId: string | null, ts: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        prevHash,
        ts,
        actorId,
        entry.action,
        entry.targetType,
        entry.targetId ?? null,
        entry.purpose,
        entry.caseRef ?? null,
        entry.params ?? {},
        entry.resultCount ?? null,
      ]),
    )
    .digest('hex');
}

/**
 * Appends one entry, linked to the current tip.
 *
 * Call it inside the same transaction as the mutation it records: an audit row without its mutation
 * is noise, and a mutation without its audit row is the thing this table exists to prevent.
 */
export async function writeAudit(
  db: DbLike,
  principal: Principal | undefined,
  entry: AuditEntry,
): Promise<{ hash: string; prevHash: string }> {
  const tip = await db
    .select({ hash: auditLog.hash })
    .from(auditLog)
    .orderBy(desc(auditLog.ts), desc(auditLog.hash))
    .limit(1);

  const prevHash = tip[0]?.hash ?? GENESIS_HASH;
  const actorId = principal?.sub ?? null;
  const ts = new Date().toISOString();
  const hash = digest(prevHash, entry, actorId, ts);

  await db.insert(auditLog).values({
    ts,
    actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    purpose: entry.purpose,
    caseRef: entry.caseRef ?? null,
    params: entry.params ?? {},
    resultCount: entry.resultCount ?? null,
    prevHash,
    hash,
  });

  return { hash, prevHash };
}
