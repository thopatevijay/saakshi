/**
 * Catalogue sync tests (D1-04).
 *
 * Against the real migrated database, never a mocked query builder: the things that can actually go
 * wrong here — the `(department_id, external_id)` upsert key, `NULLS NOT DISTINCT`, whether an
 * UPDATE was issued at all — are properties of PostgreSQL, and a mock would assert that we called
 * drizzle rather than that the registry survived a re-sync.
 *
 * The catalogue itself is always stubbed, so the suite never depends on the sandbox being up. AC 7
 * (cookie-gated upstream) is proven by the live CLI run in the ticket's validation gate, which is
 * the only place a real session cookie exists.
 *
 * Requires `make up && make migrate`. Skips loudly when the database is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { syncCatalogue, CatalogueFetchError } from './catalogue-sync.js';
import { parseCatalogue, UnknownCatalogueShapeError } from './catalogue-parse.js';

const TAG = `SYNC-${String(Date.now())}`;
const SOURCE = 'https://catalogue.invalid/api/ingest';

let rawSql: Sql;
let db: Db;
let reachable = false;

const id = (n: string): string => `${TAG}-${n}`;

/** A stub shaped exactly like the deployed sandbox: `[{id,name}]` and nothing else. */
const stub = (entries: unknown) => (): Promise<unknown> => Promise.resolve(entries);

const THREE = [
  { id: id('cam01'), name: '01 Chiman bhai Bridge' },
  { id: id('cam02'), name: '02 Janpath' },
  { id: id('cam03'), name: '03 O.N.G.C. Office' },
];

async function run(entries: unknown) {
  return syncCatalogue(db, {
    source: SOURCE,
    trigger: 'cli',
    departmentId: null,
    fetchCatalogue: stub(entries),
  });
}

interface CameraSnapshot extends Record<string, unknown> {
  external_id: string;
  name: string;
  catalogue_status: string;
  catalogue_absent_since: string | null;
  catalogue_last_seen_at: string | null;
  deleted_at: string | null;
  retention_days: number | null;
  notes: string | null;
  department_id: string | null;
  trust_score: string | null;
  status: string;
  updated_at: string;
  adapter_kind: string;
  declared_fps: string | null;
}

async function snapshot(externalId: string): Promise<CameraSnapshot | undefined> {
  const rows = await db.execute<CameraSnapshot>(
    sql`select external_id, name, catalogue_status::text, catalogue_absent_since::text,
               catalogue_last_seen_at::text, deleted_at::text, retention_days, notes,
               department_id::text, trust_score::text, status::text, updated_at::text,
               adapter_kind::text, declared_fps::text
        from cameras where external_id = ${externalId}`,
  );
  return rows[0];
}

beforeAll(async () => {
  rawSql = createSql(loadEnv().DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn(
      '[catalogue-sync] database unreachable — skipping. Run `make up && make migrate`.',
    );
  }
});

afterAll(async () => {
  if (reachable) {
    await db.execute(sql`delete from cameras where external_id like ${`${TAG}%`}`);
    await db.execute(sql`delete from catalogue_sync_runs where source = ${SOURCE}`);
  }
  await rawSql?.end();
});

// ── AC 1 · full catalogue syncs in one command ──────────────────────────────────────────────────

describe('AC 1 — a full catalogue syncs into cameras', () => {
  it('creates every entry exactly once', async () => {
    if (!reachable) return;
    const report = await run(THREE);

    expect(report.fetched).toBe(3);
    expect(report.added).toBe(3);
    expect(report.updated).toBe(0);
    expect(report.rejected).toBe(0);
    expect(report.shape).toBe('array');

    const rows = await db.execute<{ n: string; d: string }>(
      sql`select count(*)::text as n, count(distinct external_id)::text as d
          from cameras where external_id like ${`${TAG}%`}`,
    );
    // The gate's own check, at suite scale: no duplicates means the upsert key holds.
    expect(rows[0]?.n).toBe('3');
    expect(rows[0]?.d).toBe('3');
  });
});

// ── AC 2 · idempotency ──────────────────────────────────────────────────────────────────────────

describe('AC 2 — a re-sync is idempotent', () => {
  it('reports all-unchanged and writes nothing on the second and third runs', async () => {
    if (!reachable) return;
    await run(THREE);

    const before = await Promise.all(THREE.map((e) => snapshot(e.id)));

    const second = await run(THREE);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(3);
    expect(second.wentAbsent).toBe(0);
    expect(second.returned).toBe(0);

    const after = await Promise.all(THREE.map((e) => snapshot(e.id)));

    // `updated_at` means "the registry's picture of this camera changed". On an idempotent re-sync
    // it did not, so an unmoved timestamp is the proof that no content write was issued — stronger
    // than the report's own claim, which is what a report would say either way.
    for (const [index, row] of after.entries()) {
      expect(row?.updated_at).toBe(before[index]?.updated_at);
      expect(row?.name).toBe(before[index]?.name);
    }

    const third = await run(THREE);
    expect(third.unchanged).toBe(3);
    expect((await snapshot(THREE[0]!.id))?.updated_at).toBe(before[0]?.updated_at);
  });

  it('reports a genuine change as updated, not unchanged', async () => {
    if (!reachable) return;
    await run(THREE);
    const renamed = [
      { ...THREE[0]!, name: 'Chimanbhai Patel Bridge (renamed)' },
      ...THREE.slice(1),
    ];

    const report = await run(renamed);
    expect(report.updated).toBe(1);
    expect(report.unchanged).toBe(2);
    expect((await snapshot(THREE[0]!.id))?.name).toBe('Chimanbhai Patel Bridge (renamed)');

    await run(THREE); // restore, so later tests see the original name
  });
});

// ── AC 3 · enrichment survives ──────────────────────────────────────────────────────────────────

describe('AC 3 — manually enriched fields survive three consecutive re-syncs', () => {
  it('preserves retention, notes, department, trust score, status and adapter kind', async () => {
    if (!reachable) return;
    await run(THREE);

    const departmentRows = await db.execute<{ id: string }>(
      sql`select id::text from departments limit 1`,
    );
    const departmentId = departmentRows[0]?.id ?? null;
    expect(departmentId).not.toBeNull();

    // Everything a human types or a machine measures, set on one camera.
    await db.execute(sql`
      update cameras set
        retention_days = 90,
        notes = 'PTZ — presets drift after a power cycle; verify framing before quoting ANPR',
        department_id = ${departmentId}::uuid,
        trust_score = 72.5,
        status = 'degraded',
        adapter_kind = 'rtsp'
      where external_id = ${THREE[0]!.id}`);

    const enriched = await snapshot(THREE[0]!.id);
    expect(enriched?.retention_days).toBe(90);

    // The camera now belongs to a department, so a NULL-scoped sync no longer sees it — which is
    // itself the correct behaviour, and is asserted separately below. Sync in its own scope.
    for (let pass = 1; pass <= 3; pass += 1) {
      const report = await syncCatalogue(db, {
        source: SOURCE,
        trigger: 'cli',
        departmentId,
        fetchCatalogue: stub([THREE[0]]),
      });
      expect(report.fetched, `pass ${String(pass)}`).toBe(1);
      expect(report.added, `pass ${String(pass)}`).toBe(0);

      const after = await snapshot(THREE[0]!.id);
      expect(after?.retention_days, `retention, pass ${String(pass)}`).toBe(90);
      expect(after?.notes, `notes, pass ${String(pass)}`).toBe(enriched?.notes);
      expect(after?.department_id, `department, pass ${String(pass)}`).toBe(departmentId);
      expect(after?.trust_score, `trust score, pass ${String(pass)}`).toBe(enriched?.trust_score);
      expect(after?.status, `status, pass ${String(pass)}`).toBe('degraded');
      // adapter_kind is set on insert only: a re-sync must not undo an operator's transport choice.
      expect(after?.adapter_kind, `adapter kind, pass ${String(pass)}`).toBe('rtsp');
    }
  });

  it('never overwrites a stored value with a field the catalogue omitted', async () => {
    if (!reachable) return;
    const only = id('declared');
    await run([{ id: only, name: 'Declared once', fps: 25, codec: 'h264' }]);
    expect((await snapshot(only))?.declared_fps).toBe('25.00');

    // The same camera, now without the declared fields — the shape the sandbox actually returns.
    const report = await run([...THREE, { id: only, name: 'Declared once' }]);
    expect(report.unchanged).toBeGreaterThanOrEqual(1);
    expect((await snapshot(only))?.declared_fps).toBe('25.00');
  });

  it('scopes absence to one department: another department’s cameras are untouched', async () => {
    if (!reachable) return;
    const departmentRows = await db.execute<{ id: string }>(
      sql`select id::text from departments limit 1`,
    );
    const departmentId = departmentRows[0]!.id;

    // THREE[0] belongs to the department by now; a NULL-scoped sync that omits it must not mark it
    // absent. It is not missing from this catalogue — it is not in this catalogue's scope at all.
    await run(THREE.slice(1));
    const other = await snapshot(THREE[0]!.id);
    expect(other?.catalogue_status).toBe('active');
    expect(other?.department_id).toBe(departmentId);
  });
});

// ── AC 4 · absence and return ───────────────────────────────────────────────────────────────────

describe('AC 4 — a removed camera goes absent, is not deleted, and returns', () => {
  it('marks absent, keeps the row, then flips back to active', async () => {
    if (!reachable) return;
    const a = id('abs-a');
    const b = id('abs-b');
    const full = [
      { id: a, name: 'Absence A' },
      { id: b, name: 'Absence B' },
    ];

    await run(full);
    expect((await snapshot(a))?.catalogue_status).toBe('active');

    // b disappears from the catalogue.
    const gone = await run([{ id: a, name: 'Absence A' }]);
    expect(gone.wentAbsent).toBe(1);

    const absent = await snapshot(b);
    expect(absent, 'the row must still exist — never deleted').toBeDefined();
    expect(absent?.catalogue_status).toBe('absent');
    expect(absent?.catalogue_absent_since).not.toBeNull();
    expect(absent?.deleted_at, 'absence is not a delete').toBeNull();

    // A second sweep while it is still gone must not re-report it: it went absent once.
    const still = await run([{ id: a, name: 'Absence A' }]);
    expect(still.wentAbsent).toBe(0);

    // b comes back.
    const back = await run(full);
    expect(back.returned).toBe(1);
    expect(back.wentAbsent).toBe(0);

    const returned = await snapshot(b);
    expect(returned?.catalogue_status).toBe('active');
    expect(returned?.catalogue_absent_since).toBeNull();
  });

  it('does not resurrect a soft-deleted camera, and does not crash trying', async () => {
    if (!reachable) return;
    const decommissioned = id('decom');
    const listed = [...THREE, { id: decommissioned, name: 'Decommissioned' }];
    await run(listed);
    await db.execute(
      sql`update cameras set deleted_at = now() where external_id = ${decommissioned}`,
    );

    // Still listed upstream, but a human decommissioned it. A scheduled job must not undo that —
    // and, the part that actually bit: it must not try to INSERT it either. The unique key
    // `(department_id, external_id)` does not exclude soft-deleted rows, so an INSERT aborts the
    // whole transaction and every subsequent sync with it.
    const report = await run(listed);
    expect(report.skipped).toBe(1);
    expect(report.added).toBe(0);

    const row = await snapshot(decommissioned);
    expect(row?.deleted_at).not.toBeNull();

    // The disagreement is surfaced in the report, not swallowed.
    const rejection = report.rejections.find((r) => r.externalId === decommissioned);
    expect(rejection?.errors[0]?.message).toContain('will not resurrect');

    // And the next sync still works — the regression this test exists for.
    const next = await run(listed);
    expect(next.skipped).toBe(1);
    expect(next.unchanged).toBe(3);
  });
});

// ── AC 5 · unknown shape ────────────────────────────────────────────────────────────────────────

describe('AC 5 — an unknown payload shape fails loudly with the raw JSON persisted', () => {
  it('names every key it probed and persists what actually arrived', async () => {
    if (!reachable) return;
    const payload = { unexpected: { deeply: 'nested' }, count: 30 };

    await expect(run(payload)).rejects.toThrow(UnknownCatalogueShapeError);

    const runs = await db.execute<{ error: string; raw_payload: unknown; ok: boolean }>(
      sql`select error, raw_payload, ok from catalogue_sync_runs
          where source = ${SOURCE} and ok = false order by started_at desc limit 1`,
    );
    const failed = runs[0];
    expect(failed).toBeDefined();
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toContain('no recognisable camera array');
    expect(failed?.error).toContain('cameras, data, items');
    // The AC: the raw JSON is kept for inspection, not just described in a log line.
    expect(failed?.raw_payload).toEqual(payload);
  });

  it('rejects an array of rows that carry no identifier, rather than reporting an empty success', async () => {
    if (!reachable) return;
    await expect(run([{ foo: 1 }, { bar: 2 }])).rejects.toThrow(
      /none.*carried a recognisable identifier/s,
    );
  });

  it('records a failed run when the catalogue is unreachable, with no raw payload', async () => {
    if (!reachable) return;
    await expect(
      syncCatalogue(db, {
        source: SOURCE,
        trigger: 'cli',
        departmentId: null,
        fetchCatalogue: () => Promise.reject(new Error('ECONNREFUSED')),
      }),
    ).rejects.toThrow(CatalogueFetchError);

    const runs = await db.execute<{ error: string; raw_payload: unknown }>(
      sql`select error, raw_payload from catalogue_sync_runs
          where source = ${SOURCE} and ok = false order by started_at desc limit 1`,
    );
    expect(runs[0]?.error).toContain('ECONNREFUSED');
    // Nothing arrived, so there is nothing to keep. "Did not run" and "ran and found nothing" are
    // different facts and the report has to tell them apart.
    expect(runs[0]?.raw_payload).toBeNull();
  });
});

// ── AC 6 · the report is persisted ──────────────────────────────────────────────────────────────

describe('AC 6 — the sync report is persisted', () => {
  it('writes one row per run carrying all six counters', async () => {
    if (!reachable) return;
    const report = await run(THREE);

    const rows = await db.execute<{
      fetched: number;
      added: number;
      updated: number;
      unchanged: number;
      went_absent: number;
      returned: number;
      skipped: number;
      shape: string;
      trigger_source: string;
      duration_ms: number;
    }>(sql`select fetched, added, updated, unchanged, went_absent, returned, skipped, shape,
                  trigger_source, duration_ms
           from catalogue_sync_runs where id = ${report.runId}::uuid`);

    const persisted = rows[0];
    expect(persisted).toBeDefined();
    expect(persisted?.fetched).toBe(report.fetched);
    expect(persisted?.added).toBe(report.added);
    expect(persisted?.updated).toBe(report.updated);
    expect(persisted?.unchanged).toBe(report.unchanged);
    expect(persisted?.went_absent).toBe(report.wentAbsent);
    expect(persisted?.returned).toBe(report.returned);
    expect(persisted?.skipped).toBe(report.skipped);
    expect(persisted?.shape).toBe('array');
    expect(persisted?.trigger_source).toBe('cli');
    expect(persisted?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('writes one audit row per sync, so a registry change always has an actor and a purpose', async () => {
    if (!reachable) return;
    const before = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from audit_log where action = 'camera.catalogue_sync'`,
    );
    await run(THREE);
    const after = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from audit_log where action = 'camera.catalogue_sync'`,
    );
    expect(Number(after[0]?.n)).toBe(Number(before[0]?.n) + 1);
  });

  it('the counters account for every fetched entry', async () => {
    if (!reachable) return;
    const report = await run(THREE);
    expect(
      report.added + report.updated + report.unchanged + report.returned + report.skipped,
    ).toBe(report.fetched);
  });
});

// ── Tolerant parsing, in isolation ──────────────────────────────────────────────────────────────

describe('tolerant parsing', () => {
  it('accepts a bare array — the shape the sandbox actually returns', () => {
    const parsed = parseCatalogue([{ id: 'cam01', name: '01 Bridge' }]);
    expect(parsed.shape).toBe('array');
    expect(parsed.entries[0]?.externalId).toBe('cam01');
  });

  it.each([
    ['cameras', { cameras: [{ id: 'cam01' }] }],
    ['data', { data: [{ camera_id: 'cam01' }] }],
    ['items', { items: [{ externalId: 'cam01' }] }],
    ['results', { results: [{ uuid: 'cam01' }] }],
    ['channels', { channels: [{ channel_id: 'cam01' }] }],
  ])('accepts a wrapped array under %s', (key, payload) => {
    const parsed = parseCatalogue(payload);
    expect(parsed.shape).toBe(`wrapped:${key}`);
    expect(parsed.entries[0]?.externalId).toBe('cam01');
  });

  it('accepts one level of nesting', () => {
    const parsed = parseCatalogue({ data: { cameras: [{ id: 'cam01' }] } });
    expect(parsed.shape).toBe('wrapped:data.cameras');
  });

  it('accepts a list of bare id strings', () => {
    const parsed = parseCatalogue(['cam01', 'cam02']);
    expect(parsed.entries).toHaveLength(2);
    // No name upstream, so the id is the name. Better than rejecting a camera over a cosmetic field.
    expect(parsed.entries[0]?.name).toBe('cam01');
  });

  it('reads declared fields under alias keys, and only when they parse', () => {
    const parsed = parseCatalogue([
      {
        camera_id: 'cam01',
        title: 'Bridge',
        video_codec: 'h265',
        frame_rate: '25',
        width: 1920,
        height: 1080,
        latitude: 23.0301,
        longitude: 72.5145,
        zone: 'Ahmedabad',
        make: 'Hikvision',
        hls_url: 'https://host.invalid/cam01/index.m3u8',
      },
    ]);
    const entry = parsed.entries[0];
    expect(entry?.name).toBe('Bridge');
    expect(entry?.declaredCodec).toBe('h265');
    expect(entry?.declaredFps).toBe(25);
    expect(entry?.declaredResolution).toBe('1920x1080');
    expect(entry?.lat).toBe(23.0301);
    expect(entry?.district).toBe('Ahmedabad');
    expect(entry?.vendor).toBe('Hikvision');
    expect(entry?.endpoints['hls']).toBe('https://host.invalid/cam01/index.m3u8');
  });

  it('will not guess at a value it does not understand', () => {
    // "25 fps" is a claim, not a number. Declared values are already untrusted; a parsed-out guess
    // would be an untrusted value we invented ourselves.
    const parsed = parseCatalogue([{ id: 'cam01', fps: '25 fps', resolution: 'HD' }]);
    expect(parsed.entries[0]?.declaredFps).toBeUndefined();
    expect(parsed.entries[0]?.declaredResolution).toBeUndefined();
  });

  it('rejects a duplicate id within one payload rather than upserting it twice', () => {
    const parsed = parseCatalogue([{ id: 'cam01' }, { id: 'cam01' }]);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.rejections[0]?.errors[0]?.message).toContain('duplicate');
  });

  it('reports an unidentifiable row without losing the identifiable ones', () => {
    const parsed = parseCatalogue([{ id: 'cam01' }, { nothing: 'useful' }]);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.rejections).toHaveLength(1);
    expect(parsed.rejections[0]?.errors[0]?.message).toContain('no identifier found');
  });

  it('ignores a relative endpoint rather than inventing a base URL', () => {
    // `GET /api/ingest` is the contract, the URL pattern is not — so a path we cannot resolve is
    // dropped, not completed with a guess.
    const parsed = parseCatalogue([{ id: 'cam01', url: '/cam01/index.m3u8' }]);
    expect(parsed.entries[0]?.endpoints).toEqual({});
  });
});
