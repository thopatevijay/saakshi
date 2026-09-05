/**
 * The audit chain: how an entry is hashed, how one is appended without forking the chain, and how
 * the whole thing is verified afterwards (D3-04).
 *
 * **What this proves, and what it does not.** A hash chain proves tamper *evidence*, never tamper
 * *prevention*. Anyone with write access to the database and enough patience can rewrite every row
 * from the altered one onwards and produce a chain that verifies. What they cannot do is alter one
 * row and leave the rest alone — and they cannot do any of it without disabling the append-only
 * triggers first, which is itself a visible act. `docs/chain-of-custody.md` states this plainly,
 * because a claim of tamper-proofing in front of a forensic-sciences jury is a claim that will be
 * tested and will fail.
 *
 * ## The digest
 *
 *   hash_n = SHA256( prev_hash ‖ canonical_json(payload_n) )
 *
 * `canonical_json` is `@saakshi/shared`'s — sorted keys, defined number and date formats — and it
 * is load-bearing rather than tidy: `params` is a `jsonb` column, and Postgres returns jsonb in its
 * own key order, so a digest taken over `JSON.stringify` of the object the route built could not be
 * reproduced from the row the verifier reads back. Under the previous serialisation every entry
 * with a multi-key `params` was unverifiable, and it would have failed looking exactly like a
 * tamper.
 *
 * `prev_hash` is a fixed-shape token (64 hex characters, or the literal `genesis`) and the
 * canonical document always begins with `{`, so plain concatenation cannot be made ambiguous by
 * choosing a clever payload.
 *
 * ## Entries written before this ticket, and the epoch that seals them off
 *
 * Rows appended before D3-04 used a positional `JSON.stringify([...])` preimage whose `params`
 * element was serialised in the writer's **insertion** order. Postgres returns `jsonb` in its own
 * key order, so those digests cannot be recomputed from the stored row at all — not by us, not by
 * anyone. That is the defect, not a limitation of this verifier.
 *
 * Pretending otherwise would be the worst of the options: a verifier that opened by reporting a
 * breach on rows nobody touched is exactly the failure D1-06 warned about. So the boundary is made
 * explicit instead. `sealChainEpoch` appends one ordinary chain entry recording how many
 * pre-canonical entries precede it and the hash they end on; that entry is itself hashed
 * canonically, so the size of the prologue is inside the chain and cannot be enlarged after the
 * fact. Entries before the epoch are verified for **linkage only** and reported as such — their
 * payloads are not re-hashable, and `docs/chain-of-custody.md` says so in those words.
 *
 * A database migrated from empty has no prologue and never needs an epoch: every entry it has ever
 * held was written by the canonical writer.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@saakshi/shared';
import { auditLog } from '@saakshi/shared/db';
import { and, asc, desc, eq, gte, ilike, lte, sql, type SQL } from 'drizzle-orm';
import type { DbLike } from '../db/client.js';
import type { Principal } from '../auth.js';

/** First link. A chain has to start somewhere, and it should be recognisable when it does. */
export const GENESIS_HASH = 'genesis';

/** Named in every verification result and in every export manifest, so a bundle says how to check itself. */
export const CHAIN_ALGORITHM = 'sha256(prev_hash || canonical_json(entry))';

/** The action that seals off entries written before the canonical digest existed. */
export const CHAIN_EPOCH_ACTION = 'chain.epoch';

/** `target_type` on the epoch entry, so it cannot be forged by an unrelated `chain.epoch` action. */
export const CHAIN_EPOCH_TARGET = 'audit_chain';

/** How many times an append retries when it loses the race for the chain tip. */
export const CHAIN_APPEND_ATTEMPTS = 12;

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
 * Exactly what is hashed. Field names are the wire names, and there are no optionals: every field
 * is present with an explicit `null` so that "absent" and "null" cannot hash differently.
 */
export interface AuditPayload {
  action: string;
  actorBadgeNo: string | null;
  actorId: string | null;
  actorRole: string | null;
  caseRef: string | null;
  params: Record<string, unknown>;
  purpose: string;
  resultCount: number | null;
  targetId: string | null;
  targetType: string;
  ts: string;
}

/** The actor, as recorded on the entry itself rather than joined from `users` at read time. */
export interface AuditActor {
  id: string | null;
  badgeNo: string | null;
  role: string | null;
}

export function actorOf(principal: Principal | undefined): AuditActor {
  return {
    id: principal?.sub ?? null,
    badgeNo: principal?.badgeNo ?? null,
    role: principal?.role ?? null,
  };
}

export function auditPayload(entry: AuditEntry, actor: AuditActor, ts: string): AuditPayload {
  return {
    action: entry.action,
    actorBadgeNo: actor.badgeNo,
    actorId: actor.id,
    actorRole: actor.role,
    caseRef: entry.caseRef ?? null,
    params: entry.params ?? {},
    purpose: entry.purpose,
    resultCount: entry.resultCount ?? null,
    targetId: entry.targetId ?? null,
    targetType: entry.targetType,
    ts,
  };
}

export function auditDigest(prevHash: string, payload: AuditPayload): string {
  return createHash('sha256').update(prevHash).update(canonicalJson(payload)).digest('hex');
}

/** What a row of `audit_log` looks like once read back, with `params` already re-ordered by jsonb. */
export interface AuditRow {
  id: string;
  seq: number;
  ts: string;
  actorId: string | null;
  actorBadgeNo: string | null;
  actorRole: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  purpose: string;
  caseRef: string | null;
  params: Record<string, unknown>;
  resultCount: number | null;
  prevHash: string;
  hash: string;
}

export function payloadOf(row: AuditRow): AuditPayload {
  return {
    action: row.action,
    actorBadgeNo: row.actorBadgeNo,
    actorId: row.actorId,
    actorRole: row.actorRole,
    caseRef: row.caseRef,
    params: row.params ?? {},
    purpose: row.purpose,
    resultCount: row.resultCount,
    targetId: row.targetId,
    targetType: row.targetType,
    ts: row.ts,
  };
}

/**
 * `ts` re-rendered as the exact ISO-8601 string the writer hashed.
 *
 * `timestamp(mode: 'string')` hands back Postgres's own text form — `2026-09-05 11:59:08.849+00`,
 * with a space and a two-digit offset — while `writeAudit` hashed `Date#toISOString()`'s
 * `2026-09-05T11:59:08.849Z`. Hashing the value as it comes back therefore reproduces a digest that
 * never matches, on every entry, for a reason that has nothing to do with the entry's contents.
 *
 * The conversion is done in SQL rather than by handing the string to `new Date()`, because
 * JavaScript's parsing of non-ISO date strings is implementation-defined and this is the one place
 * in the system where "usually right" is not a standard.
 */
const TS_ISO = sql<string>`to_char(${auditLog.ts} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const ROW_COLUMNS = {
  id: auditLog.id,
  seq: auditLog.seq,
  ts: TS_ISO,
  actorId: auditLog.actorId,
  actorBadgeNo: auditLog.actorBadgeNo,
  actorRole: auditLog.actorRole,
  action: auditLog.action,
  targetType: auditLog.targetType,
  targetId: auditLog.targetId,
  purpose: auditLog.purpose,
  caseRef: auditLog.caseRef,
  params: auditLog.params,
  resultCount: auditLog.resultCount,
  prevHash: auditLog.prevHash,
  hash: auditLog.hash,
};

// ── Appending ───────────────────────────────────────────────────────────────────────────────────

/**
 * A lost race for the chain tip, as opposed to any other database error.
 *
 * `audit_log_prev_hash_uidx` (migration 0018) makes a fork impossible, so a concurrent writer that
 * read the same tip fails here rather than silently branching the chain. drizzle wraps driver
 * errors, so the cause chain is walked rather than the top-level object inspected.
 */
export function isChainRace(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 6; depth++) {
    const candidate = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code === '23505') {
      const constraint = String(candidate.constraint_name ?? '');
      if (constraint === 'audit_log_prev_hash_uidx' || constraint === 'audit_log_hash_key') {
        return true;
      }
    }
    current = candidate.cause;
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function appendOnce(
  tx: DbLike,
  entry: AuditEntry,
  actor: AuditActor,
): Promise<{ hash: string; prevHash: string; seq: number }> {
  const tip = await tx
    .select({ hash: auditLog.hash })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1);

  const prevHash = tip[0]?.hash ?? GENESIS_HASH;
  const ts = new Date().toISOString();
  const payload = auditPayload(entry, actor, ts);
  const hash = auditDigest(prevHash, payload);

  const inserted = await tx
    .insert(auditLog)
    .values({
      ts,
      actorId: actor.id,
      actorBadgeNo: actor.badgeNo,
      actorRole: actor.role,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      purpose: entry.purpose,
      caseRef: entry.caseRef ?? null,
      params: payload.params,
      resultCount: payload.resultCount,
      prevHash,
      hash,
    })
    .returning({ seq: auditLog.seq });

  return { hash, prevHash, seq: inserted[0]?.seq ?? 0 };
}

/**
 * Appends one entry, linked to the current tip.
 *
 * Call it inside the same transaction as the mutation it records: an audit row without its mutation
 * is noise, and a mutation without its audit row is the thing this table exists to prevent.
 *
 * **On losing the race.** Reading the tip and then inserting is not atomic, and D1-06 (#10) found
 * the consequence: two concurrent transactions read the same tip and the chain forks, which
 * verification then reports in a way indistinguishable from tampering. The fix is not a lock but a
 * unique index on `prev_hash` — the fork becomes impossible, the loser's INSERT fails, and it is
 * retried here against the new tip. The retry runs in a nested transaction so that a caller who
 * passed in their own `tx` gets a savepoint rollback rather than a poisoned transaction.
 */
export async function writeAudit(
  db: DbLike,
  principal: Principal | undefined,
  entry: AuditEntry,
): Promise<{ hash: string; prevHash: string; seq: number }> {
  const actor = actorOf(principal);
  let lastError: unknown;

  for (let attempt = 0; attempt < CHAIN_APPEND_ATTEMPTS; attempt++) {
    try {
      return await db.transaction(async (tx) => appendOnce(tx, entry, actor));
    } catch (error) {
      if (!isChainRace(error)) throw error;
      lastError = error;
      // A few milliseconds of jitter, so N writers that collided do not all retry in lockstep.
      await sleep(Math.floor(Math.random() * 4 * (attempt + 1)) + 1);
    }
  }

  throw new Error(
    `audit chain: lost the tip race ${CHAIN_APPEND_ATTEMPTS} times appending '${entry.action}'`,
    { cause: lastError },
  );
}

// ── Verifying ───────────────────────────────────────────────────────────────────────────────────

export type ChainBreakReason =
  /** The entry's stored hash is not the digest of its own contents. Something changed the row. */
  | 'hash_mismatch'
  /** The entry does not link to its predecessor. A row was removed, or reordered, or inserted. */
  | 'link_mismatch'
  /** The epoch entry's declared boundary does not match where it actually sits in the chain. */
  | 'epoch_mismatch'
  /** Entries predate the canonical digest and no epoch entry seals them off. Run `audit:verify --seal`. */
  | 'unsealed_prologue';

export type ChainEntryStatus = 'ok' | 'pre_canonical' | 'hash_mismatch';

export interface ChainEntrySummary {
  id: string;
  seq: number;
  ts: string;
  action: string;
  actorId: string | null;
  actorBadgeNo: string | null;
  actorRole: string | null;
  targetType: string;
  targetId: string | null;
  caseRef: string | null;
  hash: string;
  prevHash: string;
}

export interface ChainBreak {
  reason: ChainBreakReason;
  /** 1-based position along the chain, so "the 412th entry" is a thing a person can say. */
  position: number;
  entry: ChainEntrySummary;
  expected: string;
  actual: string;
  detail: string;
}

export interface ChainFork {
  prevHash: string;
  entryIds: string[];
}

export interface ChainVerification {
  ok: boolean;
  algorithm: string;
  checkedAt: string;
  entries: number;
  /**
   * Entries written before the canonical digest existed. Their linkage is verified; their payloads
   * cannot be re-hashed, because the preimage they were written under is not reproducible from the
   * stored row. Sealed off by the epoch entry, which is itself canonically hashed.
   */
  preCanonicalEntries: number;
  /** Entries checked against the canonical digest — the number the tamper-evidence claim covers. */
  verifiedEntries: number;
  epochSealed: boolean;
  genesisHash: string;
  tipHash: string | null;
  forks: ChainFork[];
  firstBreak: ChainBreak | null;
}

function summarise(row: AuditRow): ChainEntrySummary {
  return {
    id: row.id,
    seq: row.seq,
    ts: row.ts,
    action: row.action,
    actorId: row.actorId,
    actorBadgeNo: row.actorBadgeNo,
    actorRole: row.actorRole,
    targetType: row.targetType,
    targetId: row.targetId,
    caseRef: row.caseRef,
    hash: row.hash,
    prevHash: row.prevHash,
  };
}

/** Recomputes one entry's digest. `expected` is what its contents say the hash should be. */
export function checkEntry(row: AuditRow): { ok: boolean; expected: string } {
  const expected = auditDigest(row.prevHash, payloadOf(row));
  return { ok: expected === row.hash, expected };
}

function isEpochEntry(row: AuditRow): boolean {
  return row.action === CHAIN_EPOCH_ACTION && row.targetType === CHAIN_EPOCH_TARGET;
}

async function loadChain(db: DbLike): Promise<AuditRow[]> {
  return (await db.select(ROW_COLUMNS).from(auditLog).orderBy(asc(auditLog.seq))) as AuditRow[];
}

/**
 * Walks the whole chain and reports the first entry that does not hold up.
 *
 * The walk is in `seq` order, which is insertion order; because `audit_log_prev_hash_uidx` makes a
 * fork impossible, insertion order is also link order, and the two checks — "does this entry link
 * to the previous one" and "is this entry's hash the digest of its own contents" — between them
 * catch a modified row, a removed row, a reordered row and an inserted row.
 *
 * The one exception is the pre-canonical prologue described at the top of this file, and its size
 * is not inferred: it is read out of the epoch entry, which is itself canonically hashed and
 * therefore cannot be edited to widen the exemption.
 */
export async function verifyChain(db: DbLike): Promise<ChainVerification> {
  const rows = await loadChain(db);

  // Only reachable on a database that predates migration 0018, or one where the index was dropped.
  // It is checked anyway because a fork is the failure that looks most like a breach.
  const forkRows = await db
    .select({ prevHash: auditLog.prevHash, ids: sql<string[]>`array_agg(${auditLog.id}::text)` })
    .from(auditLog)
    .groupBy(auditLog.prevHash)
    .having(sql`count(*) > 1`);
  const forks: ChainFork[] = forkRows.map((f) => ({ prevHash: f.prevHash, entryIds: f.ids }));

  const epochRow = rows.find(isEpochEntry);

  const base = {
    algorithm: CHAIN_ALGORITHM,
    checkedAt: new Date().toISOString(),
    entries: rows.length,
    genesisHash: GENESIS_HASH,
    tipHash: rows.at(-1)?.hash ?? null,
    epochSealed: epochRow !== undefined,
    forks,
  };

  // The prologue is *computed*, never taken on the epoch entry's word: it is the maximal leading run
  // of entries that fail the canonical digest. The epoch entry then has to agree with what the chain
  // actually shows, which is what turns it from a claim into a pin — an attacker who tampered with
  // entries 2..10 to widen the exempt region would move the computed boundary away from the sealed
  // one, and that disagreement is itself the break.
  let prologue = 0;
  while (prologue < rows.length && !checkEntry(rows[prologue] as AuditRow).ok) prologue++;

  if (prologue > 0 && epochRow === undefined) {
    const row = rows[0] as AuditRow;
    return {
      ...base,
      ok: false,
      preCanonicalEntries: prologue,
      verifiedEntries: 0,
      firstBreak: {
        reason: 'unsealed_prologue',
        position: 1,
        entry: summarise(row),
        expected: 'an epoch entry recording where the pre-canonical prologue ends',
        actual: `${prologue} leading entr${prologue === 1 ? 'y' : 'ies'} whose preimage cannot be reproduced from the stored row`,
        detail:
          'entries written before D3-04 are present and nothing seals them off — run `npm run audit:verify -- --seal` to record the boundary in the chain',
      },
    };
  }

  if (epochRow !== undefined) {
    const declaredPrologue = Number(epochRow.params['preCanonicalEntries'] ?? -1);
    const declaredBoundary = String(epochRow.params['boundaryHash'] ?? '');
    const actualBoundary = prologue === 0 ? GENESIS_HASH : (rows[prologue - 1] as AuditRow).hash;
    if (declaredPrologue !== prologue || declaredBoundary !== actualBoundary) {
      return {
        ...base,
        ok: false,
        preCanonicalEntries: prologue,
        verifiedEntries: 0,
        firstBreak: {
          reason: 'epoch_mismatch',
          position: rows.indexOf(epochRow) + 1,
          entry: summarise(epochRow),
          expected: `${declaredPrologue} pre-canonical entries ending at ${declaredBoundary}`,
          actual: `${prologue} ending at ${actualBoundary}`,
          detail:
            'the sealed boundary and the boundary the chain shows disagree — entries moved across it after it was sealed',
        },
      };
    }
  }

  let firstBreak: ChainBreak | null = null;
  let verifiedEntries = 0;
  let previousHash = GENESIS_HASH;

  for (const [index, row] of rows.entries()) {
    const position = index + 1;

    // Linkage is checked for every entry, prologue included: a removed, reordered or inserted row
    // shows up here whether or not its payload can be re-hashed.
    if (row.prevHash !== previousHash) {
      firstBreak = {
        reason: 'link_mismatch',
        position,
        entry: summarise(row),
        expected: previousHash,
        actual: row.prevHash,
        detail:
          position === 1
            ? `the first entry does not chain from ${GENESIS_HASH}`
            : `entry ${position} does not chain from entry ${position - 1}`,
      };
      break;
    }

    if (index >= prologue) {
      const check = checkEntry(row);
      if (!check.ok) {
        firstBreak = {
          reason: 'hash_mismatch',
          position,
          entry: summarise(row),
          expected: check.expected,
          actual: row.hash,
          detail: `entry ${position} (${row.action}) does not hash to its stored value — its contents changed after it was written`,
        };
        break;
      }
      verifiedEntries++;
    }

    previousHash = row.hash;
  }

  return {
    ...base,
    ok: firstBreak === null && forks.length === 0,
    preCanonicalEntries: prologue,
    verifiedEntries,
    firstBreak,
  };
}

/**
 * Records, in the chain itself, where the pre-canonical prologue ends.
 *
 * Idempotent, and refuses to run on a chain that does not need it: if every entry already verifies
 * canonically there is nothing to seal, and sealing anyway would create an exemption where none was
 * warranted. The entry it writes is an ordinary audited action — it has a purpose, it is linked, and
 * it is hashed the same way everything after it is.
 */
export async function sealChainEpoch(
  db: DbLike,
  principal?: Principal,
): Promise<{ sealed: boolean; preCanonicalEntries: number; reason?: string }> {
  const rows = await loadChain(db);
  if (rows.some(isEpochEntry)) {
    const existing = rows.find(isEpochEntry) as AuditRow;
    return {
      sealed: false,
      preCanonicalEntries: Number(existing.params['preCanonicalEntries'] ?? 0),
      reason: 'the chain already carries an epoch entry',
    };
  }

  let prologue = 0;
  while (prologue < rows.length && !checkEntry(rows[prologue] as AuditRow).ok) prologue++;

  if (prologue === 0) {
    return { sealed: false, preCanonicalEntries: 0, reason: 'no pre-canonical entries to seal' };
  }
  if (prologue < rows.length) {
    // Sealing only ever covers a *leading* run. An unverifiable entry after a verifiable one is a
    // tamper, and sealing must never be the thing that makes a tamper disappear.
    const after = rows.slice(prologue).findIndex((row) => !checkEntry(row).ok);
    if (after !== -1) {
      return {
        sealed: false,
        preCanonicalEntries: prologue,
        reason: `entry ${prologue + after + 1} fails verification after ${prologue} that pass — that is a break, not a prologue`,
      };
    }
  }

  const boundary = rows[prologue - 1] as AuditRow;
  await writeAudit(db, principal, {
    action: CHAIN_EPOCH_ACTION,
    targetType: CHAIN_EPOCH_TARGET,
    targetId: boundary.hash,
    purpose:
      'sealing the boundary between entries written before the canonical digest and those written after it',
    params: { preCanonicalEntries: prologue, boundaryHash: boundary.hash, algorithm: CHAIN_ALGORITHM },
    resultCount: prologue,
  });

  return { sealed: true, preCanonicalEntries: prologue };
}

/**
 * The `seq` of the epoch entry, or `null` when the chain has no prologue to seal.
 *
 * Entries below it are pre-canonical: linked, but not re-hashable. The viewer needs this to label
 * them honestly instead of showing them as broken.
 */
export async function chainEpochSeq(db: DbLike): Promise<number | null> {
  const rows = await db
    .select({ seq: auditLog.seq })
    .from(auditLog)
    .where(and(eq(auditLog.action, CHAIN_EPOCH_ACTION), eq(auditLog.targetType, CHAIN_EPOCH_TARGET)))
    .orderBy(asc(auditLog.seq))
    .limit(1);
  return rows[0]?.seq ?? null;
}

/** The chain tip, for stamping into an export manifest. */
export async function chainTip(db: DbLike): Promise<{ hash: string; seq: number } | null> {
  const rows = await db
    .select({ hash: auditLog.hash, seq: auditLog.seq })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1);
  const tip = rows[0];
  return tip === undefined ? null : { hash: tip.hash, seq: tip.seq };
}

// ── Searching ───────────────────────────────────────────────────────────────────────────────────

export interface AuditSearch {
  actorId?: string | undefined;
  badgeNo?: string | undefined;
  action?: string | undefined;
  caseRef?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface AuditSearchEntry extends ChainEntrySummary {
  purpose: string;
  params: Record<string, unknown>;
  resultCount: number | null;
  status: ChainEntryStatus;
}

export interface AuditSearchResult {
  total: number;
  limit: number;
  offset: number;
  entries: AuditSearchEntry[];
}

export const AUDIT_SEARCH_MAX_LIMIT = 200;

/**
 * The auditor's read of the chain.
 *
 * Each returned entry carries its own `status`, recomputed from its contents rather than trusted —
 * a viewer that showed rows without re-checking them would be a list, not an audit. The status here
 * is per-entry (`ok` / `legacy` / `hash_mismatch`); whether the *chain* holds is `verifyChain`,
 * because a link break is a property of a pair of entries, not of one.
 */
export async function searchAudit(db: DbLike, search: AuditSearch = {}): Promise<AuditSearchResult> {
  const limit = Math.min(Math.max(search.limit ?? 50, 1), AUDIT_SEARCH_MAX_LIMIT);
  const offset = Math.max(search.offset ?? 0, 0);

  const filters: SQL[] = [];
  if (search.actorId !== undefined) filters.push(eq(auditLog.actorId, search.actorId));
  if (search.badgeNo !== undefined) filters.push(eq(auditLog.actorBadgeNo, search.badgeNo));
  if (search.action !== undefined) filters.push(ilike(auditLog.action, `${search.action}%`));
  if (search.caseRef !== undefined) filters.push(eq(auditLog.caseRef, search.caseRef));
  if (search.targetType !== undefined) filters.push(eq(auditLog.targetType, search.targetType));
  if (search.targetId !== undefined) filters.push(eq(auditLog.targetId, search.targetId));
  if (search.from !== undefined) filters.push(gte(auditLog.ts, search.from));
  if (search.to !== undefined) filters.push(lte(auditLog.ts, search.to));

  const where = filters.length === 0 ? undefined : and(...filters);

  const [totals, rows, epochSeq] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(where),
    db
      .select(ROW_COLUMNS)
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.seq))
      .limit(limit)
      .offset(offset) as Promise<AuditRow[]>,
    chainEpochSeq(db),
  ]);

  return {
    total: totals[0]?.n ?? 0,
    limit,
    offset,
    entries: rows.map((row) => decorate(row, epochSeq)),
  };
}

function decorate(row: AuditRow, epochSeq: number | null): AuditSearchEntry {
  const status: ChainEntryStatus =
    epochSeq !== null && row.seq < epochSeq
      ? 'pre_canonical'
      : checkEntry(row).ok
        ? 'ok'
        : 'hash_mismatch';
  return {
    ...summarise(row),
    purpose: row.purpose,
    params: row.params ?? {},
    resultCount: row.resultCount,
    status,
  };
}

/** One entry by id, for the viewer's detail pane. */
export async function readAuditEntry(db: DbLike, id: string): Promise<AuditSearchEntry | null> {
  const rows = (await db.select(ROW_COLUMNS).from(auditLog).where(eq(auditLog.id, id)).limit(1)) as AuditRow[];
  const row = rows[0];
  if (row === undefined) return null;
  return decorate(row, await chainEpochSeq(db));
}
