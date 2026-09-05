/**
 * Alert engine tests (D2-06) — AC 1, 4, 5, 6, 7, 8-unit and 9, plus the SSE end-to-end.
 *
 * Against the real migrated database, like every other suite in this package. What can actually go
 * wrong here is Postgres-shaped: the `(dedupe_key, dedupe_window_start)` unique index, the
 * `numeric(6,3)` distance column that 0016 widened, the validity-window predicate, the audit
 * chain's foreign key on `actor_id`. A mocked query builder would prove none of it.
 *
 * The plate strings are **measured output from the real 5-minute 8-camera live run**, not invented
 * registrations — `GJ35U07`, `GJ32DD10`, `GJ3266416`, `AAM412`, `44671`, `1118R`, `46101` and
 * `757508300`, with the confidences D2-01 recorded. `757508300` is the hoarding's phone number that
 * was the highest-confidence read of the whole run; it is here because an alert engine that fires on
 * it is the failure this ticket exists to prevent.
 *
 * Requires `make up && npm run db:migrate`. Skips loudly when the database is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { REQUIRED_WHY_FIELDS, EXPLAINED_NULL_FIELDS, type AlertRecord } from '@saakshi/shared';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';
import { buildServer, type App } from '../server.js';
import type { UserRole } from '../auth.js';
import {
  AlertEngine,
  DeliveryGate,
  identificationStrength,
  loadAlertPolicy,
  POLICY_PATH,
  severityFor,
  transitionAlert,
  AlertTransitionError,
  type AlertPolicy,
} from './alerts.js';
import { ConfusionPlateMatcher } from './plate-search.js';
import { evidenceStoreFromEnv, type EvidenceStore } from './evidence.js';
import {
  createWatchlistRegistry,
  loadSeedCsv,
  SEED_CSV_PATH,
  upsertWatchlistEntries,
} from '../watchlist/index.js';

const TAG = `AL${String(Date.now()).slice(-9)}`;
/** Track ids this suite owns, so teardown removes exactly its sightings and nothing else. */
const TRACK_BASE = 90_000_000 + (Date.now() % 1_000_000);

let rawSql: Sql;
let db: Db;
let env: Env;
let app: App;
let engine: AlertEngine;
let evidence: EvidenceStore | null = null;
let reachable = false;
let cameraA = '';
let cameraB = '';
let trackSeq = 0;

const actors: Record<UserRole, { sub: string; badgeNo: string }> = {
  admin: { sub: '', badgeNo: 'GP-ADM-0001' },
  supervisor: { sub: '', badgeNo: 'GP-SUP-0100' },
  operator: { sub: '', badgeNo: 'GP-OPR-1042' },
  auditor: { sub: '', badgeNo: 'GP-AUD-0007' },
};

function principal(role: UserRole) {
  return { ...actors[role], role, departmentId: null };
}

function auth(role: UserRole): { authorization: string } {
  return { authorization: `Bearer ${app.jwt.sign(principal(role))}` };
}

/** One sighting on a real registry camera, in the camera's own time base. */
async function seedSighting(options: {
  cameraId: string;
  ts: string;
  cropUri?: string | null;
  isBestShot?: boolean;
}): Promise<{ id: string; ts: string; trackId: number }> {
  const trackId = TRACK_BASE + trackSeq++;
  const rows = await db.execute<{ id: string; ts: string }>(sql`
    insert into sightings (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence,
                           crop_uri, is_best_shot)
    values (${options.cameraId}::uuid, ${options.ts}, ${4_000 + trackSeq}, ${trackId}, 'car',
            '{"x":10,"y":20,"w":100,"h":80}'::jsonb, 0.87,
            ${options.cropUri ?? null}, ${options.isBestShot ?? false})
    returning id::text as id, ts
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('sighting insert returned no row');
  return { id: row.id, ts: row.ts, trackId };
}

/** The slice of a byte stream reader this suite uses — see the note at its call site. */
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

function get(object: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc === null || typeof acc !== 'object' ? undefined : (acc as Record<string, unknown>)[key],
      object,
    );
}

/** A policy file on disk with one deep merge applied, for the "config, not code" criterion. */
function policyFileWith(mutate: (policy: AlertPolicy) => void): string {
  const base = JSON.parse(JSON.stringify(loadAlertPolicy(POLICY_PATH))) as AlertPolicy;
  mutate(base);
  const dir = mkdtempSync(path.join(tmpdir(), 'alert-policy-'));
  const file = path.join(dir, 'alert-policy.json');
  writeFileSync(file, JSON.stringify(base, null, 2));
  return file;
}

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);

  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[alerts] database unreachable — skipping. Run `make up && npm run db:migrate`.');
    return;
  }

  const users = await db.execute<{ id: string; badge_no: string }>(
    sql`select id::text as id, badge_no from users`,
  );
  for (const role of Object.keys(actors) as UserRole[]) {
    const row = users.find((u) => u.badge_no === actors[role].badgeNo);
    if (row === undefined) throw new Error(`seed user ${actors[role].badgeNo} missing`);
    actors[role].sub = row.id;
  }

  // Self-seeding, like the watchlist suites: the validation gate runs the tests before
  // `npm run seed:watchlist`, and a suite that only passes in one order is not a gate.
  const batch = await loadSeedCsv(SEED_CSV_PATH);
  await upsertWatchlistEntries(db, batch.valid);

  const cams = await db.execute<{ id: string; external_id: string }>(
    sql`select id::text as id, external_id from cameras
         where external_id in ('cam07','cam08') order by external_id`,
  );
  cameraA = cams.find((c) => c.external_id === 'cam07')?.id ?? '';
  cameraB = cams.find((c) => c.external_id === 'cam08')?.id ?? '';
  if (cameraA === '' || cameraB === '') throw new Error('cam07/cam08 missing — run make migrate');

  evidence = evidenceStoreFromEnv();
  engine = new AlertEngine({
    db,
    registry: createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) }),
  });

  app = await buildServer({ env, db, alertEngine: engine });
  await app.ready();
});

afterAll(async () => {
  if (reachable) {
    await db.execute(sql`delete from alerts where dedupe_key like ${`%${TAG}%`}`);
    await db.execute(
      sql`delete from alerts where last_sighting_id in
            (select id from sightings where track_id >= ${TRACK_BASE} and track_id < ${TRACK_BASE + 1000})`,
    );
    await db.execute(
      sql`delete from sightings where track_id >= ${TRACK_BASE} and track_id < ${TRACK_BASE + 1000}`,
    );
    await db.execute(sql`delete from watchlist_entries where source_ref like ${`${TAG}%`}`);
    // audit_log is append-only and is deliberately left alone.
  }
  await app?.close();
  await rawSql?.end();
});

/* ── AC 1 · read → alert, end to end ─────────────────────────────────────────────────────────── */

describe('AC 1 — a seeded watchlist plate on the feed raises an alert within 10 s', () => {
  it('raises an alert on the exact estate string GJ3266416 and delivers it on the stream', async () => {
    if (!reachable) return;
    const at = new Date().toISOString();
    const sighting = await seedSighting({ cameraId: cameraA, ts: at });

    const delivered: AlertRecord[] = [];
    const unsubscribe = engine.bus.subscribe((event) => {
      if (event.type === 'alert') delivered.push(event.alert);
    });

    const started = Date.now();
    const outcome = await engine.correlate({
      sightingId: sighting.id,
      sightingTs: sighting.ts,
      cameraId: cameraA,
      // Measured: the live run emitted this on cam07 at confidence 0.449 (docs/anpr-accuracy.md §8).
      rawText: 'GJ3266416',
      confidence: 0.449,
    });
    const elapsedMs = Date.now() - started;
    unsubscribe();

    expect(outcome.skipped).toBeNull();
    expect(outcome.created).toBe(1);
    expect(outcome.alerts).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(10_000);
    expect(delivered.map((a) => a.id)).toContain(outcome.alerts[0]?.id);

    console.log(`  [AC 1] read → persisted alert → stream in ${String(elapsedMs)} ms`);
  });

  it('never alerts on 757508300 — the hoarding phone number that was the run’s best read', async () => {
    if (!reachable) return;
    const sighting = await seedSighting({ cameraId: cameraA, ts: new Date().toISOString() });
    const outcome = await engine.correlate({
      sightingId: sighting.id,
      sightingTs: sighting.ts,
      cameraId: cameraA,
      rawText: '757508300',
      // The highest-confidence plate read of the entire live run. Confidence is not the question.
      confidence: 0.888,
    });
    expect(outcome.alerts).toHaveLength(0);
    expect(outcome.skipped).toBe('no_watchlist_hit');
    expect(outcome.fuzzyRefused).toBe(true);
  });

  it('refuses a read below the policy confidence floor before any lookup runs', async () => {
    if (!reachable) return;
    const sighting = await seedSighting({ cameraId: cameraA, ts: new Date().toISOString() });
    const outcome = await engine.correlate({
      sightingId: sighting.id,
      sightingTs: sighting.ts,
      cameraId: cameraA,
      rawText: 'GJ3266416',
      confidence: 0.05,
    });
    expect(outcome.skipped).toBe('below_confidence_floor');
    expect(outcome.alerts).toHaveLength(0);
  });
});

/* ── AC 4 · severity from category, changed by config ────────────────────────────────────────── */

describe('AC 4 — severity comes from the watchlist category, and config alone changes it', () => {
  const input = {
    category: 'stolen_vehicle' as const,
    entrySeverity: 'high' as const,
    matchType: 'exact' as const,
    validity: 'valid' as const,
    combinedConfidence: 0.95,
  };

  it('assigns from the shipped policy', () => {
    const policy = loadAlertPolicy(POLICY_PATH);
    expect(severityFor(policy, input).final).toBe('high');
    expect(
      severityFor(policy, { ...input, category: 'wanted_person', entrySeverity: 'critical' }).final,
    ).toBe('critical');
    expect(
      severityFor(policy, { ...input, category: 'missing_person', entrySeverity: 'low' }).final,
    ).toBe('low');
  });

  it('preserves the ticket ordering as a strict rank, which four severity levels cannot carry', () => {
    const policy = loadAlertPolicy(POLICY_PATH);
    const rank = (category: keyof typeof policy.severity.categoryRank): number =>
      policy.severity.categoryRank[category];
    expect(rank('wanted_person')).toBeLessThan(rank('stolen_vehicle'));
    expect(rank('stolen_vehicle')).toBeLessThan(rank('blacklisted_vehicle'));
    expect(rank('blacklisted_vehicle')).toBeLessThan(rank('suspect'));
    expect(rank('suspect')).toBeLessThan(rank('missing_person'));
  });

  it('changes with a config edit and no code change', () => {
    const file = policyFileWith((p) => {
      p.severity.byCategory.stolen_vehicle = 'critical';
      p.severity.entrySeverity = 'ignore';
    });
    const before = severityFor(loadAlertPolicy(POLICY_PATH), input).final;
    const after = severityFor(loadAlertPolicy(file), input).final;
    expect(before).toBe('high');
    expect(after).toBe('critical');
  });

  it('lets identification quality LOWER severity but never raise it', () => {
    const policy = loadAlertPolicy(POLICY_PATH);
    const strong = severityFor(policy, input);
    const weak = severityFor(policy, {
      ...input,
      matchType: 'fuzzy',
      validity: 'partial',
      combinedConfidence: 0.34,
    });
    expect(strong.final).toBe('high');
    expect(strong.ceilingsApplied).toEqual([]);
    expect(weak.final).toBe('medium');
    expect(weak.ceilingsApplied).toContain('combined-below-55');

    // The one thing that must be impossible: a confident detector out-ranking the category.
    const veryConfident = severityFor(policy, {
      ...input,
      category: 'missing_person',
      entrySeverity: 'low',
      combinedConfidence: 1,
    });
    expect(veryConfident.final).toBe('low');
  });

  it('caps an ungrammatical read at low, however confident the OCR was', () => {
    const policy = loadAlertPolicy(POLICY_PATH);
    const outcome = severityFor(policy, {
      category: 'wanted_person',
      entrySeverity: 'critical',
      matchType: 'exact',
      validity: 'invalid',
      combinedConfidence: 0.99,
    });
    expect(outcome.fromCategory).toBe('critical');
    expect(outcome.final).toBe('low');
    expect(outcome.ceilingsApplied).toContain('ungrammatical-read');
  });
});

/* ── AC 5 · the why-payload ──────────────────────────────────────────────────────────────────── */

describe('AC 5 — every alert carries a complete why-payload', () => {
  it('has no null in any required field, and every permitted null carries a caveat', async () => {
    if (!reachable) return;
    const sighting = await seedSighting({ cameraId: cameraA, ts: new Date().toISOString() });
    const outcome = await engine.correlate({
      sightingId: sighting.id,
      sightingTs: sighting.ts,
      cameraId: cameraA,
      rawText: 'AAM412',
      confidence: 0.503,
    });
    const alert = outcome.alerts[0];
    expect(alert).toBeDefined();
    if (alert === undefined) return;

    const missing = REQUIRED_WHY_FIELDS.filter((field) => {
      const value = get(alert.reason, field);
      return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
    });
    expect(missing).toEqual([]);

    for (const [field, phrase] of Object.entries(EXPLAINED_NULL_FIELDS)) {
      if (get(alert.reason, field) !== null) continue;
      expect(
        alert.reason.caveats.some((c) => c.toLowerCase().includes(phrase.toLowerCase())),
        `null at ${field} with no caveat saying "${phrase}"`,
      ).toBe(true);
    }

    // The claim that must never be implied, present on the payload itself rather than in a README.
    expect(alert.reason.watchlistRecord.live).toBe(false);
    expect(alert.reason.disclaimer).toMatch(/no live VAHAN/i);
    expect(alert.reason.caveats[0]).toMatch(/mock/i);
    // The provenance of the seeded string travels with the alert.
    expect(alert.reason.watchlistRecord.note).toMatch(/MEASURED ANPR OUTPUT/);
  });

  it('survives the wire: the served alert parses as AlertRecord with its payload intact', async () => {
    if (!reachable) return;
    const sighting = await seedSighting({ cameraId: cameraA, ts: new Date().toISOString() });
    const outcome = await engine.correlate({
      sightingId: sighting.id,
      sightingTs: sighting.ts,
      cameraId: cameraA,
      rawText: '1118R',
      confidence: 0.627,
    });
    const id = outcome.alerts[0]?.id;
    expect(id).toBeDefined();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/alerts/${String(id)}`,
      headers: auth('operator'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AlertRecord>();
    expect(body.reason.identification.combinedConfidence).toBeCloseTo(
      body.reason.identification.adjustedPlateConfidence *
        body.reason.identification.matchConfidence,
      5,
    );
    expect(REQUIRED_WHY_FIELDS.every((f) => get(body.reason, f) !== null)).toBe(true);
  });

  it('carries a crop the operator can actually open — a GET-signed URL that returns 200', async () => {
    if (!reachable) return;
    if (evidence === null) {
      console.warn('[alerts] MINIO_* unset — signed-crop assertion skipped, the null is caveated');
      return;
    }
    const ts = new Date().toISOString();
    // A real object in the real bucket. `crop_uri` is `s3://bucket/key`, never a URL: a signed URL
    // persisted in the database is a credential with an expiry, and it would be dead within the
    // hour (D2-02's handoff).
    const key = `evidence/cam07/${ts.slice(0, 10)}/${TAG}-plate.jpg`;
    await evidence.putObject(key, Buffer.from(`saakshi-d2-06-${TAG}`), 'image/jpeg');
    const sighting = await seedSighting({
      cameraId: cameraA,
      ts,
      cropUri: `s3://${evidence.bucket}/${key}`,
      isBestShot: true,
    });

    const outcome = await engine.correlate({
      sightingId: sighting.id,
      sightingTs: sighting.ts,
      cameraId: cameraA,
      rawText: '46101',
      confidence: 0.56,
    });
    const alert = outcome.alerts[0];
    expect(alert?.reason.evidence.cropUri).toBe(`s3://${evidence.bucket}/${key}`);
    expect(alert?.reason.evidence.cropUrl).toBeTruthy();

    // GET, not HEAD: a pre-signed URL is signed for one method, and a HEAD of a GET-presigned URL
    // is a different canonical request that answers 403 against a store that is working perfectly.
    const fetched = await fetch(String(alert?.reason.evidence.cropUrl));
    expect(fetched.status).toBe(200);
    await evidence.deleteObject(key);
  });
});

/* ── AC 6 · fuzzy matches are flagged, with their distance ───────────────────────────────────── */

describe('AC 6 — a fuzzy match is flagged as fuzzy and carries its distance', () => {
  it('recovers GJ35U07 → GJ35U0779 and never presents it as certainty', async () => {
    if (!reachable) return;
    const sighting = await seedSighting({ cameraId: cameraA, ts: new Date().toISOString() });
    const outcome = await engine.correlate({
      sightingId: sighting.id,
      sightingTs: sighting.ts,
      cameraId: cameraA,
      rawText: 'GJ35U07',
      confidence: 0.6,
    });
    const alert = outcome.alerts[0];
    expect(alert?.matchType).toBe('fuzzy');
    expect(alert?.matchDistance).toBeGreaterThan(0);
    // Continuous under D2-04's weighted metric — 0.70, not 1. A test that allowed an integer here
    // would pass against the `integer` column 0016 replaced, which is the bug it exists to catch.
    expect(Number.isInteger(alert?.matchDistance)).toBe(false);
    expect(alert?.matchDistance).toBeCloseTo(0.7, 2);
    expect(alert?.reason.matchDistance).toBe(alert?.matchDistance);
    expect(alert?.reason.identification.strength).not.toBe('confirmed');
    expect(alert?.reason.caveats.join(' ')).toMatch(/FUZZY MATCH/);
    expect(alert?.reason.caveats.join(' ')).toMatch(/ranked possibility, not an identification/);

    console.log(
      `  [AC 6] GJ35U07 → GJ35U0779  distance ${String(alert?.matchDistance)}  ` +
        `matchConfidence ${String(alert?.reason.identification.matchConfidence)}  ` +
        `combined ${String(alert?.confidence)}  severity ${String(alert?.severity)}`,
    );
  });

  it('recovers GJ32DD10 → GJ32D0107, the second live fuzzy path', async () => {
    if (!reachable) return;
    const sighting = await seedSighting({ cameraId: cameraA, ts: new Date().toISOString() });
    const outcome = await engine.correlate({
      sightingId: sighting.id,
      sightingTs: sighting.ts,
      cameraId: cameraA,
      rawText: 'GJ32DD10',
      confidence: 0.6,
    });
    const alert = outcome.alerts[0];
    expect(alert?.matchType).toBe('fuzzy');
    expect(alert?.matchDistance).toBeCloseTo(0.55, 2);

    console.log(
      `  [AC 6] GJ32DD10 → GJ32D0107  distance ${String(alert?.matchDistance)}  ` +
        `severity ${String(alert?.severity)}`,
    );
  });

  it('gives an exact match distance 0 and confidence 1 on the match half', async () => {
    if (!reachable) return;
    const sighting = await seedSighting({ cameraId: cameraA, ts: new Date().toISOString() });
    const outcome = await engine.correlate({
      sightingId: sighting.id,
      sightingTs: sighting.ts,
      cameraId: cameraA,
      rawText: '44671',
      confidence: 0.732,
    });
    const alert = outcome.alerts[0];
    expect(alert?.matchType).toBe('exact');
    expect(alert?.matchDistance).toBe(0);
    expect(alert?.reason.identification.matchConfidence).toBe(1);
    // Exact on a five-digit string is still not an identification, and the payload says so.
    expect(alert?.severity).toBe('low');
    expect(alert?.reason.identification.strength).toBe('weak');
  });
});

/* ── AC 7 · lifecycle ────────────────────────────────────────────────────────────────────────── */

describe('AC 7 — lifecycle transitions are enforced and every one is audited', () => {
  async function auditCount(alertId: string): Promise<number> {
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from audit_log where target_id = ${alertId} and action like 'alert.%'`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async function newAlert(plate = 'AAM412', confidence = 0.503): Promise<AlertRecord> {
    const sighting = await seedSighting({ cameraId: cameraB, ts: new Date().toISOString() });
    const outcome = await engine.correlate({
      sightingId: sighting.id,
      sightingTs: sighting.ts,
      cameraId: cameraB,
      rawText: plate,
      confidence,
    });
    const alert = outcome.alerts[0];
    if (alert === undefined) throw new Error('no alert raised for the lifecycle fixture');
    return alert;
  }

  it('allows new → ack → escalated and records the actor on each', async () => {
    if (!reachable) return;
    const alert = await newAlert();
    const before = await auditCount(alert.id);

    const acked = await transitionAlert(db, alert.id, 'ack', principal('operator'));
    expect(acked.status).toBe('ack');
    expect(acked.ackedBy).toBe(actors.operator.sub);
    expect(acked.ackedAt).not.toBeNull();
    expect(acked.statusChangedBy).toBe(actors.operator.sub);

    const escalated = await transitionAlert(db, alert.id, 'escalated', principal('supervisor'));
    expect(escalated.status).toBe('escalated');
    expect(escalated.statusChangedBy).toBe(actors.supervisor.sub);
    // An escalation must not erase who acknowledged it — different questions, different columns.
    expect(escalated.ackedBy).toBe(actors.operator.sub);

    expect(await auditCount(alert.id)).toBe(before + 2);
  });

  it('refuses to ack a dismissed alert — dismissed is terminal', async () => {
    if (!reachable) return;
    const alert = await newAlert('1118R', 0.627);
    await transitionAlert(db, alert.id, 'dismissed', principal('operator'));
    await expect(transitionAlert(db, alert.id, 'ack', principal('admin'))).rejects.toBeInstanceOf(
      AlertTransitionError,
    );
    const rows = await db.execute<{ status: string }>(
      sql`select status from alerts where id = ${alert.id}::uuid`,
    );
    expect(rows[0]?.status).toBe('dismissed');
  });

  it('answers 409 over HTTP for an illegal transition, and 403 for an auditor', async () => {
    if (!reachable) return;
    const alert = await newAlert('46101', 0.56);
    await transitionAlert(db, alert.id, 'dismissed', principal('operator'));

    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/alerts/${alert.id}/transition`,
      headers: auth('operator'),
      payload: { to: 'ack' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: string }>().error).toBe('illegal_transition');

    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/v1/alerts/${alert.id}/transition`,
      headers: auth('auditor'),
      payload: { to: 'escalated' },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('writes the audit row in the same transaction as the update', async () => {
    if (!reachable) return;
    const alert = await newAlert('GJ3266416', 0.449);
    await transitionAlert(db, alert.id, 'ack', principal('operator'), 'test purpose');
    const rows = await db.execute<{ action: string; purpose: string; actor_id: string }>(
      sql`select action, purpose, actor_id::text as actor_id from audit_log
           where target_id = ${alert.id} order by ts desc limit 1`,
    );
    expect(rows[0]?.action).toBe('alert.ack');
    expect(rows[0]?.purpose).toBe('test purpose');
    expect(rows[0]?.actor_id).toBe(actors.operator.sub);
  });
});

/* ── AC 8 (unit half) · the delivery cap ─────────────────────────────────────────────────────── */

describe('AC 8 — the delivery cap holds and the overflow is digested, not dropped', () => {
  it('admits exactly the cap in a window and accounts for every suppressed alert', () => {
    const policy = JSON.parse(JSON.stringify(loadAlertPolicy(POLICY_PATH))) as AlertPolicy;
    policy.rateLimit.deliveriesPerMinute = 120;
    let clock = 1_800_000_000_000;
    const gate = new DeliveryGate(policy, () => clock);

    let delivered = 0;
    for (let i = 0; i < 500; i += 1) {
      const admitted = gate.admit({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        severity: 'low',
        category: 'blacklisted_vehicle',
        cameraId: 'cam',
      });
      if (admitted) delivered += 1;
    }
    expect(delivered).toBe(120);
    expect(gate.stats().suppressed).toBe(380);
    expect(delivered + gate.stats().suppressed).toBe(500);

    // The next minute starts a fresh allowance — a cap that never resets is an outage.
    clock += 60_000;
    expect(gate.admit({ id: 'x', severity: 'low', category: 'suspect', cameraId: 'cam' })).toBe(
      true,
    );
  });
});

/* ── AC 9 · expired entries ──────────────────────────────────────────────────────────────────── */

describe('AC 9 — an expired watchlist entry generates no alert', () => {
  it('matches inside the validity window and stays silent outside it', async () => {
    if (!reachable) return;
    const plate = `GJ01ZZ${String(TRACK_BASE).slice(-4)}`;
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-06-01T00:00:00.000Z';
    await db.execute(sql`
      insert into watchlist_entries (category, entity_type, plate_normalized, source_system,
                                     source_ref, severity, valid_from, valid_to, active, meta)
      values ('stolen_vehicle', 'vehicle', ${plate}, 'VAHAN', ${`${TAG}-EXPIRED`}, 'high',
              ${from}, ${to}, true, '{"note":"D2-06 validity boundary fixture"}'::jsonb)
    `);

    const inside = await seedSighting({ cameraId: cameraB, ts: '2026-03-01T12:00:00.000Z' });
    const insideOutcome = await engine.correlate({
      sightingId: inside.id,
      sightingTs: inside.ts,
      cameraId: cameraB,
      rawText: plate,
      confidence: 0.9,
    });
    expect(insideOutcome.alerts).toHaveLength(1);

    // After the window closed. Evaluated at the SIGHTING's instant, not `now` — replaying against
    // `now` is what silently drops every entry whose window has since closed (D2-05's handoff).
    const after = await seedSighting({ cameraId: cameraB, ts: '2026-08-01T12:00:00.000Z' });
    const afterOutcome = await engine.correlate({
      sightingId: after.id,
      sightingTs: after.ts,
      cameraId: cameraB,
      rawText: plate,
      confidence: 0.9,
    });
    expect(afterOutcome.alerts).toHaveLength(0);
    expect(afterOutcome.skipped).toBe('no_watchlist_hit');

    // Exclusive upper bound: an entry whose window closes at T does not match AT T.
    const boundary = await seedSighting({ cameraId: cameraB, ts: to });
    const boundaryOutcome = await engine.correlate({
      sightingId: boundary.id,
      sightingTs: boundary.ts,
      cameraId: cameraB,
      rawText: plate,
      confidence: 0.9,
    });
    expect(boundaryOutcome.alerts).toHaveLength(0);
  });
});

/* ── The SSE surface ─────────────────────────────────────────────────────────────────────────── */

describe('the alert stream', () => {
  it('refuses an unauthenticated connection', async () => {
    if (!reachable) return;
    const response = await app.inject({ method: 'GET', url: '/api/v1/alerts/stream' });
    expect(response.statusCode).toBe(401);
  });

  /**
   * A real socket, not `app.inject()`.
   *
   * `inject` waits for the response to complete, and an SSE response never completes — the test
   * that used it timed out at 5 s having proved nothing. Streaming has to be tested by streaming.
   */
  it('delivers a live alert to a real SSE client, with its crop and its caveats', async () => {
    if (!reachable) return;
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const token = app.jwt.sign(principal('operator'));
      const controller = new AbortController();
      // EventSource cannot set an Authorization header — the token goes in the query string.
      const response = await fetch(`${address}/api/v1/alerts/stream?access_token=${token}`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);

      // `ReadableStreamDefaultReader` is a DOM type and this package compiles with node's lib only,
      // so the reader arrives untyped. Declaring the two members used keeps the type-aware lint
      // rules meaningful instead of silencing them.
      const reader = response.body?.getReader() as unknown as ByteReader | undefined;
      expect(reader).toBeDefined();
      if (reader === undefined) return;
      const decoder = new TextDecoder();
      let buffer = '';

      const readUntil = async (marker: string): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while (!buffer.includes(marker)) {
          if (Date.now() > deadline) throw new Error(`stream never produced '${marker}'`);
          const chunk = await reader.read();
          if (chunk.done || chunk.value === undefined) throw new Error('stream closed early');
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      };

      await readUntil('event: ready');
      expect(buffer).toMatch(/no live VAHAN/i);

      const started = Date.now();
      const sighting = await seedSighting({ cameraId: cameraA, ts: new Date().toISOString() });
      await engine.correlate({
        sightingId: sighting.id,
        sightingTs: sighting.ts,
        cameraId: cameraA,
        rawText: 'GJ35U07',
        confidence: 0.6,
      });
      await readUntil('event: alert');
      const elapsedMs = Date.now() - started;
      expect(elapsedMs).toBeLessThan(10_000);

      const line = buffer
        .split('\n\n')
        .find((block) => block.includes('event: alert'))
        ?.split('\n')
        .find((l) => l.startsWith('data: '));
      expect(line).toBeDefined();
      const alert = JSON.parse(String(line).slice(6)) as AlertRecord;
      expect(alert.matchType).toBe('fuzzy');
      expect(alert.reason.watchlistRecord.live).toBe(false);
      expect(alert.reason.caveats.join(' ')).toMatch(/FUZZY MATCH/);
      expect(REQUIRED_WHY_FIELDS.every((f) => get(alert.reason, f) !== null)).toBe(true);

      console.log(
        `  [gate] live SSE: read → 'event: alert' on the wire in ${String(elapsedMs)} ms ` +
          `(severity ${alert.severity}, distance ${String(alert.matchDistance)})`,
      );
      controller.abort();
      await reader.cancel().catch(() => undefined);
    } finally {
      // `app.close()` in afterAll also stops the listener; this makes the suite order-independent.
    }
  }, 30_000);

  it('lists, filters and reports the measured dedupe ratio', async () => {
    if (!reachable) return;
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/alerts?limit=5&sort=severity',
      headers: auth('operator'),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ data: AlertRecord[]; disclaimer: string }>();
    expect(body.disclaimer).toMatch(/no live VAHAN/i);
    for (const alert of body.data) expect(alert.reason.watchlistRecord.live).toBe(false);

    // Was `auth('auditor')`. D3-04 moved the queue's read endpoints off `READ_ROLES` — which is
    // every signed-in role — and onto `alerts:view`, which the shared RBAC table has never granted
    // an auditor: "the audit function examines what was done, not the footage itself". The
    // navigation already hid this screen from them; the server was the side that disagreed.
    const auditorStats = await app.inject({
      method: 'GET',
      url: '/api/v1/alerts/stats',
      headers: auth('auditor'),
    });
    expect(auditorStats.statusCode).toBe(403);

    const stats = await app.inject({
      method: 'GET',
      url: '/api/v1/alerts/stats',
      headers: auth('supervisor'),
    });
    expect(stats.statusCode).toBe(200);
    const s = stats.json<{ total: number; totalSightings: number; dedupeRatio: number }>();
    expect(s.totalSightings).toBeGreaterThanOrEqual(s.total);
    expect(s.dedupeRatio).toBeGreaterThanOrEqual(0);
  });
});

/* ── The strength label ──────────────────────────────────────────────────────────────────────── */

describe('identification strength', () => {
  it('never says "confirmed" for a fuzzy match or an ungrammatical read', () => {
    expect(identificationStrength(1, 'fuzzy', true)).not.toBe('confirmed');
    expect(identificationStrength(1, 'exact', false)).not.toBe('confirmed');
    expect(identificationStrength(0.95, 'exact', true)).toBe('confirmed');
    expect(identificationStrength(0.6, 'exact', true)).toBe('probable');
    expect(identificationStrength(0.35, 'exact', true)).toBe('possible');
    expect(identificationStrength(0.1, 'exact', true)).toBe('weak');
  });
});
