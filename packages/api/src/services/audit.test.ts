/**
 * The audit chain (D3-04): the digest, the append that cannot fork, verification, purpose binding,
 * the export bundle, and the auditor's ceiling.
 *
 * The tamper case lives next door in `audit-tamper.test.ts` so the ticket's validation gate can run
 * it on its own; everything else that has to hold for the chain to mean anything is here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { UserRole } from '@saakshi/shared';
import { canonicalJson } from '@saakshi/shared';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';
import { buildServer, type App } from '../server.js';
import {
  CHAIN_ALGORITHM,
  GENESIS_HASH,
  auditDigest,
  auditPayload,
  chainTip,
  searchAudit,
  verifyChain,
  writeAudit,
} from './audit.js';
import { verifyExportBundle } from './export-bundle.js';

let app: App;
let rawSql: Sql;
let db: Db;
let env: Env;
let reachable = false;
let exportDir = '';

const TAG = `AUDIT-${Date.now()}`;

const actors: Record<UserRole, { sub: string; badgeNo: string }> = {
  admin: { sub: '', badgeNo: 'GP-ADM-0001' },
  supervisor: { sub: '', badgeNo: 'GP-SUP-0100' },
  operator: { sub: '', badgeNo: 'GP-OPR-1042' },
  auditor: { sub: '', badgeNo: 'GP-AUD-0007' },
};

function auth(role: UserRole): { authorization: string } {
  return { authorization: `Bearer ${app.jwt.sign({ ...actors[role], role, departmentId: null })}` };
}

/**
 * Audit rows for one target, never a global count.
 *
 * vitest runs suites in parallel and `audit_log` is shared, so `count(*) before + 1` is a race that
 * fails while nothing is wrong. Count what the assertion is actually about.
 */
async function auditRowsFor(targetId: string): Promise<{ action: string; purpose: string }[]> {
  return db.execute<{ action: string; purpose: string }>(
    sql`select action, purpose from audit_log where target_id = ${targetId} order by seq`,
  );
}

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 8);
  db = createDb(rawSql);

  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[audit] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }

  const users = await db.execute<{ id: string; badge_no: string }>(
    sql`select id, badge_no from users`,
  );
  for (const role of Object.keys(actors) as UserRole[]) {
    const row = users.find((u) => u.badge_no === actors[role].badgeNo);
    if (row === undefined)
      throw new Error(`seed user ${actors[role].badgeNo} missing — run make migrate`);
    actors[role].sub = row.id;
  }

  exportDir = await mkdtemp(path.join(tmpdir(), 'saakshi-bundle-'));
  app = await buildServer({ env, db, exportDir });
  await app.ready();
});

afterAll(async () => {
  // `audit_log` is append-only and is deliberately left alone; the rows this suite wrote are tagged
  // so they can be found, not removed.
  await app?.close();
  await rawSql?.end();
});

// ── The digest ──────────────────────────────────────────────────────────────────────────────────

describe('the chain digest', () => {
  const entry = {
    action: 'trace.run',
    targetType: 'vehicle',
    targetId: 'GJ01AB1234',
    purpose: 'FIR follow-up',
    caseRef: 'FIR/2026/00123',
    params: { zeta: 1, alpha: { delta: 4, charlie: 3 }, beta: [1, 2] },
    resultCount: 6,
  };
  const actor = { id: null, badgeNo: 'GP-ADM-0001', role: 'admin' };
  const ts = '2026-09-05T09:00:00.000Z';

  it('is stable across key insertion order, which is what jsonb changes on the way back', () => {
    const straight = auditPayload(entry, actor, ts);
    const shuffled = auditPayload(
      { ...entry, params: { beta: [1, 2], alpha: { charlie: 3, delta: 4 }, zeta: 1 } },
      actor,
      ts,
    );
    expect(auditDigest(GENESIS_HASH, shuffled)).toBe(auditDigest(GENESIS_HASH, straight));
  });

  it('changes when any single field changes', () => {
    const base = auditDigest(GENESIS_HASH, auditPayload(entry, actor, ts));
    const variants = [
      auditPayload({ ...entry, purpose: 'FIR follow-up.' }, actor, ts),
      auditPayload({ ...entry, resultCount: 7 }, actor, ts),
      auditPayload({ ...entry, caseRef: 'FIR/2026/00124' }, actor, ts),
      auditPayload(entry, { ...actor, badgeNo: 'GP-SUP-0100' }, ts),
      auditPayload(entry, actor, '2026-09-05T09:00:00.001Z'),
    ];
    for (const variant of variants) {
      expect(auditDigest(GENESIS_HASH, variant)).not.toBe(base);
    }
    expect(auditDigest('other-prev', auditPayload(entry, actor, ts))).not.toBe(base);
  });

  it('is reproducible by a separate process from the canonical document alone', () => {
    const payload = auditPayload(entry, actor, ts);
    const expected = auditDigest(GENESIS_HASH, payload);
    const script = [
      "const { createHash } = await import('node:crypto');",
      'const [prev, doc] = process.argv.slice(1);',
      "process.stdout.write(createHash('sha256').update(prev).update(doc).digest('hex'));",
    ].join('\n');
    const out = execFileSync(
      process.execPath,
      ['--no-warnings', '--input-type=module', '-e', script, GENESIS_HASH, canonicalJson(payload)],
      { encoding: 'utf8' },
    );
    expect(out).toBe(expected);
  });
});

// ── Appending ───────────────────────────────────────────────────────────────────────────────────

describe('appending to the chain', () => {
  it('links each entry to the tip that preceded it', async () => {
    if (!reachable) return;
    const target = `${TAG}-link`;
    const first = await writeAudit(db, undefined, {
      action: 'test.append',
      targetType: 'test',
      targetId: target,
      purpose: 'chain linkage',
    });
    const second = await writeAudit(db, undefined, {
      action: 'test.append',
      targetType: 'test',
      targetId: target,
      purpose: 'chain linkage',
    });
    expect(second.prevHash).toBe(first.hash);
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  it('records the actor badge and role on the entry, not only a foreign key', async () => {
    if (!reachable) return;
    const target = `${TAG}-actor`;
    await writeAudit(
      db,
      { sub: actors.supervisor.sub, badgeNo: 'GP-SUP-0100', role: 'supervisor', departmentId: null },
      { action: 'test.actor', targetType: 'test', targetId: target, purpose: 'actor capture' },
    );
    const rows = await db.execute<{ actor_badge_no: string; actor_role: string }>(
      sql`select actor_badge_no, actor_role from audit_log where target_id = ${target}`,
    );
    expect(rows[0]?.actor_badge_no).toBe('GP-SUP-0100');
    expect(rows[0]?.actor_role).toBe('supervisor');
  });

  it('D1-06 (#10): sixteen concurrent writers do not fork the chain', async () => {
    if (!reachable) return;
    const target = `${TAG}-concurrent`;
    // Each in its own transaction, which is the shape that forked the chain before migration 0018:
    // every writer reads the same tip under READ COMMITTED. The unique index on `prev_hash` makes
    // the fork impossible and `writeAudit` retries the loser against the new tip.
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        db.transaction(async (tx) =>
          writeAudit(tx, undefined, {
            action: 'test.concurrent',
            targetType: 'test',
            targetId: target,
            purpose: `concurrent append ${i}`,
            params: { i },
          }),
        ),
      ),
    );

    const rows = await auditRowsFor(target);
    expect(rows).toHaveLength(16);

    const verification = await verifyChain(db);
    expect(verification.forks).toEqual([]);
    expect(verification.ok).toBe(true);
  });

  it('nests inside a caller transaction without poisoning it', async () => {
    if (!reachable) return;
    const target = `${TAG}-nested`;
    await db.transaction(async (tx) => {
      await writeAudit(tx, undefined, {
        action: 'test.nested',
        targetType: 'test',
        targetId: target,
        purpose: 'inside a caller transaction',
      });
      await writeAudit(tx, undefined, {
        action: 'test.nested',
        targetType: 'test',
        targetId: target,
        purpose: 'inside a caller transaction',
      });
    });
    expect(await auditRowsFor(target)).toHaveLength(2);
  });
});

// ── Verification ────────────────────────────────────────────────────────────────────────────────

describe('chain verification', () => {
  it('passes on the live chain and names the algorithm it used', async () => {
    if (!reachable) return;
    const result = await verifyChain(db);
    expect(result.ok).toBe(true);
    expect(result.firstBreak).toBeNull();
    expect(result.forks).toEqual([]);
    expect(result.algorithm).toBe(CHAIN_ALGORITHM);
    expect(result.entries).toBeGreaterThan(0);
    expect(result.verifiedEntries + result.preCanonicalEntries).toBe(result.entries);
  });

  it('the tip it reports is the tip the writer chains from next', async () => {
    if (!reachable) return;
    const tip = await chainTip(db);
    const next = await writeAudit(db, undefined, {
      action: 'test.tip',
      targetType: 'test',
      targetId: `${TAG}-tip`,
      purpose: 'tip continuity',
    });
    expect(next.prevHash).toBe(tip?.hash);
  });
});

// ── Purpose binding ─────────────────────────────────────────────────────────────────────────────

describe('purpose binding is enforced server-side', () => {
  it('a trace with no purpose is a 400', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/trace?plate=GJ01AB1234',
      headers: auth('supervisor'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('validation_failed');
  });

  it('a trace with a blank purpose is a 400', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/trace?plate=GJ01AB1234&purpose=%20%20',
      headers: auth('supervisor'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('a plate search with no purpose is a 400', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/plates/search?q=GJ01AB1234',
      headers: auth('supervisor'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('a trace WITH a purpose succeeds and writes exactly one audit entry carrying it', async () => {
    if (!reachable) return;
    const plate = `GJ99ZZ${String(Date.now()).slice(-4)}`;
    const purpose = `${TAG} vehicle movement reconstruction`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/trace?plate=${plate}&purpose=${encodeURIComponent(purpose)}&case_ref=FIR/2026/00123`,
      headers: auth('supervisor'),
    });
    expect(res.statusCode).toBe(200);

    const rows = await db.execute<{ action: string; purpose: string; case_ref: string; actor_badge_no: string }>(
      sql`select action, purpose, case_ref, actor_badge_no from audit_log where target_id = ${plate}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('trace.run');
    expect(rows[0]?.purpose).toBe(purpose);
    expect(rows[0]?.case_ref).toBe('FIR/2026/00123');
    expect(rows[0]?.actor_badge_no).toBe('GP-SUP-0100');
  });

  it('a plate search WITH a purpose succeeds and is recorded', async () => {
    if (!reachable) return;
    const q = `GJ88YY${String(Date.now()).slice(-4)}`;
    const purpose = `${TAG} plate search`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/plates/search?q=${q}&purpose=${encodeURIComponent(purpose)}`,
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(200);
    const rows = await auditRowsFor(q);
    expect(rows.map((r) => r.action)).toEqual(['plate.search']);
    expect(rows[0]?.purpose).toBe(purpose);
  });

  it('the CSV and PDF forms of a trace are audited too — an export is more consequential, not less', async () => {
    if (!reachable) return;
    const plate = `GJ77XX${String(Date.now()).slice(-4)}`;
    const purpose = `${TAG} export forms`;
    for (const suffix of ['.csv', '.pdf']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/trace${suffix}?plate=${plate}&purpose=${encodeURIComponent(purpose)}`,
        headers: auth('supervisor'),
      });
      expect(res.statusCode).toBe(200);
    }
    const rows = await auditRowsFor(plate);
    expect(rows.map((r) => r.action).sort()).toEqual(['trace.export.csv', 'trace.export.pdf']);
  });
});

// ── The export bundle ───────────────────────────────────────────────────────────────────────────

describe('export bundles', () => {
  const purpose = 'evidence package for the file';

  it('an export with no case reference is rejected server-side', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/audit/export',
      headers: auth('supervisor'),
      payload: { plate: 'GJ01AB1234', purpose },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('validation_failed');
  });

  it('an export with a blank case reference is rejected too', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/audit/export',
      headers: auth('supervisor'),
      payload: { plate: 'GJ01AB1234', purpose, case_ref: '  ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('produces a bundle that verifies, and fails on a single altered byte', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/audit/export',
      headers: auth('supervisor'),
      payload: { plate: 'GJ01AB1234', purpose, case_ref: 'FIR/2026/00123' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ bundleId: string; path: string; manifestHash: string; auditEntryHash: string }>();

    const clean = await verifyExportBundle(body.path);
    expect(clean.ok).toBe(true);
    expect(clean.failures).toEqual([]);
    expect(clean.manifestHash).toBe(body.manifestHash);

    // The manifest names the chain entry that authorised the export, so provenance does not stop at
    // the bundle's own front cover.
    const manifest = JSON.parse(
      await readFile(path.join(body.path, 'manifest.json'), 'utf8'),
    ) as { chain: { auditEntryHash: string }; items: { path: string }[]; claim: string };
    expect(manifest.chain.auditEntryHash).toBe(body.auditEntryHash);
    const chainRow = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from audit_log where hash = ${body.auditEntryHash} and action = 'export.bundle'`,
    );
    expect(chainRow[0]?.n).toBe('1');

    // Alter one byte of one listed file. The verifier must fail AT that file.
    const victim = manifest.items.find((item) => item.path !== 'manifest.json');
    expect(victim).toBeDefined();
    const victimPath = path.join(body.path, (victim as { path: string }).path);
    const bytes = await readFile(victimPath);
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 0xff;
    await writeFile(victimPath, bytes);

    const tampered = await verifyExportBundle(body.path);
    expect(tampered.ok).toBe(false);
    expect(tampered.failures).toHaveLength(1);
    expect(tampered.failures[0]?.reason).toBe('item_hash_mismatch');
    expect(tampered.failures[0]?.path).toBe((victim as { path: string }).path);
  });

  it('ships a zero-dependency verifier that agrees with ours', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/audit/export',
      headers: auth('admin'),
      payload: { plate: 'GJ01AB1234', purpose, case_ref: 'FIR/2026/00124' },
    });
    expect(res.statusCode).toBe(201);
    const { path: dir } = res.json<{ path: string }>();

    const files = await readdir(dir);
    expect(files).toEqual(expect.arrayContaining(['manifest.json', 'manifest.sha256', 'verify.mjs', 'README.txt']));

    const out = execFileSync(process.execPath, [path.join(dir, 'verify.mjs')], { encoding: 'utf8' });
    expect(out).toContain('PASS');
    expect(out).toContain('does not prove the contents are true');
  });

  it('a bundle carries no signed URL — a credential with an expiry is dead on arrival', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/audit/export',
      headers: auth('admin'),
      payload: { plate: 'GJ01AB1234', purpose, case_ref: 'FIR/2026/00125' },
    });
    const { path: dir } = res.json<{ path: string }>();
    for (const name of ['manifest.json', 'trace.json', 'trace.csv', 'README.txt']) {
      const text = await readFile(path.join(dir, name), 'utf8');
      expect(text, `${name} must not embed a presigned URL`).not.toContain('X-Amz-Signature');
      expect(text, `${name} must not embed a presigned URL`).not.toContain('X-Amz-Credential');
    }
  });

  it('makes no identification claim and names no government registry as consulted', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/audit/export',
      headers: auth('admin'),
      payload: { plate: 'GJ01AB1234', purpose, case_ref: 'FIR/2026/00126' },
    });
    const { path: dir } = res.json<{ path: string }>();
    const readme = await readFile(path.join(dir, 'README.txt'), 'utf8');
    expect(readme).toContain('no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity');
    expect(readme).toContain('performs no face recognition');
    expect(readme).toContain('It does not prove the contents are true');
  });
});

// ── The auditor's ceiling ───────────────────────────────────────────────────────────────────────

describe('RBAC — an auditor reads the chain and does nothing else', () => {
  it('reads the chain', async () => {
    if (!reachable) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/audit?limit=5', headers: auth('auditor') });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: unknown[]; disclaimer: string }>();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.disclaimer).toContain('no live VAHAN');
  });

  it('verifies the chain', async () => {
    if (!reachable) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/audit/verify', headers: auth('auditor') });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean; claim: string }>().claim).toContain('tamper EVIDENCE');
  });

  it.each([
    ['GET', '/api/v1/trace?plate=GJ01AB1234&purpose=checking'],
    ['GET', '/api/v1/trace.csv?plate=GJ01AB1234&purpose=checking'],
    ['GET', '/api/v1/plates/search?q=GJ01AB1234&purpose=checking'],
    ['GET', '/api/v1/alerts'],
  ])('is refused %s %s', async (method, url) => {
    if (!reachable) return;
    const res = await app.inject({ method: method as 'GET', url, headers: auth('auditor') });
    expect(res.statusCode).toBe(403);
  });

  it('cannot build an evidence bundle — reading the chain is not reading the footage', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/audit/export',
      headers: auth('auditor'),
      payload: { plate: 'GJ01AB1234', purpose: 'curiosity', case_ref: 'FIR/2026/00199' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('cannot mutate the registry', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: auth('auditor'),
      payload: { externalId: `${TAG}-nope`, name: 'nope', adapterKind: 'hls' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('an operator may trace but may not export — the two capabilities are separate on purpose', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/audit/export',
      headers: auth('operator'),
      payload: { plate: 'GJ01AB1234', purpose: 'operator export', case_ref: 'FIR/2026/00198' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('an operator cannot read the chain at all', async () => {
    if (!reachable) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/audit', headers: auth('operator') });
    expect(res.statusCode).toBe(403);
  });
});

// ── Search ──────────────────────────────────────────────────────────────────────────────────────

describe('searching the chain', () => {
  it('filters by badge, action and case reference', async () => {
    if (!reachable) return;
    const caseRef = `${TAG.replace(/[^A-Za-z0-9]/g, '-')}-CASE`;
    await writeAudit(
      db,
      { sub: actors.admin.sub, badgeNo: 'GP-ADM-0001', role: 'admin', departmentId: null },
      {
        action: 'test.search',
        targetType: 'test',
        targetId: `${TAG}-search`,
        purpose: 'searchable entry',
        caseRef,
      },
    );

    const byCase = await searchAudit(db, { caseRef });
    expect(byCase.total).toBe(1);
    expect(byCase.entries[0]?.actorBadgeNo).toBe('GP-ADM-0001');
    expect(byCase.entries[0]?.status).toBe('ok');

    const byBadgeAndAction = await searchAudit(db, { badgeNo: 'GP-ADM-0001', action: 'test.search' });
    expect(byBadgeAndAction.entries.some((e) => e.caseRef === caseRef)).toBe(true);

    const byAction = await searchAudit(db, { action: 'test.searchXXX' });
    expect(byAction.total).toBe(0);
  });

  it('returns entries newest first, and each carries a recomputed status', async () => {
    if (!reachable) return;
    const page = await searchAudit(db, { limit: 5 });
    expect(page.entries.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < page.entries.length; i++) {
      expect((page.entries[i - 1] as { seq: number }).seq).toBeGreaterThan(
        (page.entries[i] as { seq: number }).seq,
      );
    }
    expect(page.entries.every((e) => e.status === 'ok' || e.status === 'pre_canonical')).toBe(true);
  });
});
