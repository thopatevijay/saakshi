/**
 * The tamper test (D3-04): alter one entry's payload directly in the database and prove that
 * verification names **that** entry as the first broken link.
 *
 * It runs on its own so the ticket's validation gate can invoke it by name
 * (`npm run test -w packages/api -- audit-tamper`) and read a single answer.
 *
 * ## Getting a tamper to happen at all is part of the evidence
 *
 * `audit_log` refuses `UPDATE` twice over (D1-01): `saakshi_app` holds only SELECT and INSERT, and
 * BEFORE UPDATE/DELETE triggers raise `restrict_violation` even for the table's owner. So this suite
 * has to disable a trigger before it can tamper — which is the point worth making to a jury. An
 * attacker cannot quietly edit a row; they must first disable a guard that is visible in any schema
 * diff, and then the hash still gives them away.
 *
 * ## Everything happens inside one transaction that is rolled back
 *
 * The chain is a shared, append-only structure and other suites run against it in parallel. A
 * committed tamper would be permanent — there is no DELETE — and would break every other suite's
 * verification. So the tamper, the verification and the assertions all run inside a transaction that
 * is deliberately aborted, and the chain the rest of the world sees is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { auditLog } from '@saakshi/shared/db';
import { createDb, createSql, type Db, type DbLike, type Sql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { verifyChain, writeAudit } from './audit.js';

let rawSql: Sql;
let db: Db;
let reachable = false;

/** Rolled back at the end of every case. Nothing here ever commits. */
class Rollback extends Error {}

beforeAll(async () => {
  const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 2);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[audit-tamper] database unreachable — skipping. Run `make up && make migrate`.');
  }
});

afterAll(async () => {
  await rawSql?.end();
});

/**
 * Runs `body` against a transaction that seeds three fresh entries, then always rolls back.
 *
 * The seeded entries are what gets tampered with, so the case never depends on what happens to be
 * in the chain — and, because everything is aborted, the chain is identical afterwards.
 */
async function inTamperSandbox(
  body: (tx: DbLike, seeded: { id: string; hash: string }[]) => Promise<void>,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // `set local` — reverted with the transaction, so the guard is never off outside it.
      await tx.execute('set local role none').catch(() => undefined);
      const seeded: { id: string; hash: string }[] = [];
      for (const n of [1, 2, 3]) {
        const written = await writeAudit(tx, undefined, {
          action: 'tamper.fixture',
          targetType: 'test',
          targetId: `TAMPER-${Date.now()}-${n}`,
          purpose: `seeded entry ${n} for the tamper test`,
          params: { n, note: 'this is the value that will be altered' },
          resultCount: n,
        });
        seeded.push({ id: '', hash: written.hash });
      }

      const rows = await tx
        .select({ id: auditLog.id, hash: auditLog.hash })
        .from(auditLog)
        .orderBy(asc(auditLog.seq));
      for (const entry of seeded) {
        entry.id = rows.find((r) => r.hash === entry.hash)?.id ?? '';
      }

      await body(tx, seeded);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

/**
 * Disables the append-only triggers for the duration of this transaction only.
 *
 * `SET LOCAL session_replication_role = replica` rather than `ALTER TABLE ... DISABLE TRIGGER`, and
 * the difference is not stylistic. `ALTER TABLE` takes a `ShareRowExclusiveLock` on `audit_log`,
 * which conflicts with every concurrent `INSERT` into it — and since D3-04's unique index makes
 * concurrent writers queue on the chain tip, the two together produced real `deadlock detected`
 * (40P01) failures in unrelated suites the moment this one ran in parallel with them.
 *
 * `session_replication_role` is a session GUC: it suppresses user triggers for this transaction and
 * takes no lock at all, so nothing outside this transaction is affected or delayed.
 */
async function withTriggerDisabled(tx: DbLike, body: () => Promise<void>): Promise<void> {
  await tx.execute("set local session_replication_role = 'replica'");
  try {
    await body();
  } finally {
    await tx.execute("set local session_replication_role = 'origin'");
  }
}

describe('a tampered entry is identified, and it is the right one', () => {
  it('the database refuses the UPDATE outright until a guard is disabled', async () => {
    if (!reachable) return;
    await inTamperSandbox(async (tx, seeded) => {
      const victim = seeded[1] as { id: string };
      // drizzle wraps the driver error, so the trigger's own message is in `cause`, not on top.
      // Asserting on the wrapper's text would pass for any failed query at all.
      const refusal = await tx
        .execute(`update audit_log set purpose = 'tampered' where id = '${victim.id}'`)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refusal, 'the UPDATE must be refused, not silently applied').not.toBeNull();
      const messages: string[] = [];
      for (let current: unknown = refusal, depth = 0; current !== undefined && depth < 6; depth++) {
        const candidate = current as { message?: unknown; cause?: unknown };
        if (typeof candidate.message === 'string') messages.push(candidate.message);
        current = candidate.cause;
      }
      expect(messages.join(' | ')).toMatch(/append-only/i);
    });
  });

  it('verification names the tampered entry as the first broken link', async () => {
    if (!reachable) return;
    await inTamperSandbox(async (tx, seeded) => {
      const victim = seeded[1] as { id: string; hash: string };

      const before = await verifyChain(tx);
      expect(before.ok, 'the chain must verify before the tamper, or the test proves nothing').toBe(
        true,
      );

      await withTriggerDisabled(tx, async () => {
        await tx.execute(
          `update audit_log set purpose = 'a purpose nobody stated' where id = '${victim.id}'` as never,
        );
      });

      const after = await verifyChain(tx);
      expect(after.ok).toBe(false);
      expect(after.firstBreak).not.toBeNull();
      expect(after.firstBreak?.reason).toBe('hash_mismatch');
      expect(after.firstBreak?.entry.id).toBe(victim.id);
      expect(after.firstBreak?.actual).toBe(victim.hash);
      expect(after.firstBreak?.expected).not.toBe(victim.hash);
      expect(after.firstBreak?.detail).toContain('its contents changed after it was written');
    });
  });

  it('it is the FIRST break that is reported, not merely a break', async () => {
    if (!reachable) return;
    await inTamperSandbox(async (tx, seeded) => {
      const [, second, third] = seeded as { id: string; hash: string }[];
      await withTriggerDisabled(tx, async () => {
        // Tamper with the later one first, so "found it" cannot be an artefact of write order.
        await tx.execute(`update audit_log set result_count = 99 where id = '${third?.id}'`);
        await tx.execute(`update audit_log set result_count = 98 where id = '${second?.id}'`);
      });

      const after = await verifyChain(tx);
      expect(after.ok).toBe(false);
      expect(after.firstBreak?.entry.id).toBe(second?.id);
    });
  });

  it('altering the params object — the jsonb column — is caught like any other field', async () => {
    if (!reachable) return;
    await inTamperSandbox(async (tx, seeded) => {
      const victim = seeded[2] as { id: string };
      await withTriggerDisabled(tx, async () => {
        await tx.execute(
          `update audit_log set params = '{"n": 3, "note": "quietly changed"}'::jsonb where id = '${victim.id}'` as never,
        );
      });
      const after = await verifyChain(tx);
      expect(after.ok).toBe(false);
      expect(after.firstBreak?.reason).toBe('hash_mismatch');
      expect(after.firstBreak?.entry.id).toBe(victim.id);
    });
  });

  it('removing an entry breaks the LINK, and the entry after it is named', async () => {
    if (!reachable) return;
    await inTamperSandbox(async (tx, seeded) => {
      const [, second, third] = seeded as { id: string }[];
      await withTriggerDisabled(tx, async () => {
        await tx.execute(`delete from audit_log where id = '${second?.id}'`);
      });

      const after = await verifyChain(tx);
      expect(after.ok).toBe(false);
      expect(after.firstBreak?.reason).toBe('link_mismatch');
      expect(after.firstBreak?.entry.id).toBe(third?.id);
      expect(after.firstBreak?.detail).toContain('does not chain from');
    });
  });

  it('and the chain is untouched afterwards — every case above was rolled back', async () => {
    if (!reachable) return;
    const result = await verifyChain(db);
    expect(result.ok).toBe(true);
    expect(result.firstBreak).toBeNull();
  });
});
