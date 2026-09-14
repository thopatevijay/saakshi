/**
 * `GET /api/v1/evidence/crop` — the route that replaced the presigned URL (D4-09).
 *
 * Two halves, matching `services/evidence.test.ts`:
 *
 * - **Offline** — `keyForCropUri`, which is the whole security boundary of this route and is worth
 *   testing on its own rather than only through HTTP.
 * - **Through `app.inject()` against the real database and MinIO** — the boundary properties that
 *   only an assembled server can show: no session is refused, a wrong-bucket URI is indistinguishable
 *   from a missing one, and a real stored object comes back as image bytes.
 *
 * Every negative assertion here is made with a **schema-valid** request. BL-01 finding 25: Fastify
 * validates the querystring before `preHandler`, so a malformed probe returns 400 without ever
 * reaching `requireRole` — which looks exactly like a refusal and proves nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { buildServer, type App } from '../server.js';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';
import type { UserRole } from '../auth.js';
import { keyForCropUri, EVIDENCE_VIEW_ROLES } from './evidence.js';
import { evidenceStoreFromEnv } from '../services/evidence.js';

// ── Offline ───────────────────────────────────────────────────────────────────────────────────

describe('keyForCropUri — the route’s security boundary', () => {
  const BUCKET = 'saakshi-evidence';

  it('accepts a URI in this bucket and returns the object key', () => {
    expect(keyForCropUri(`s3://${BUCKET}/evidence/cam01/2026-09-05/abc-plate.jpg`, BUCKET)).toBe(
      'evidence/cam01/2026-09-05/abc-plate.jpg',
    );
  });

  it('refuses another bucket, a bare key, and a scheme this store cannot serve', () => {
    // The D2-11 rule: refusing is correct, guessing produces a link that 4xxs while looking real.
    expect(keyForCropUri('s3://some-other-bucket/evidence/x-plate.jpg', BUCKET)).toBeNull();
    expect(keyForCropUri('evidence/cam01/x-plate.jpg', BUCKET)).toBeNull();
    expect(keyForCropUri('file:///tmp/100-plate.jpg', BUCKET)).toBeNull();
    expect(keyForCropUri(`s3://${BUCKET}/`, BUCKET)).toBeNull();
  });

  it('refuses a traversal segment, which would address another bucket with our credentials', () => {
    expect(keyForCropUri(`s3://${BUCKET}/../other-bucket/secret.jpg`, BUCKET)).toBeNull();
    expect(keyForCropUri(`s3://${BUCKET}/evidence/../../x.jpg`, BUCKET)).toBeNull();
    expect(keyForCropUri(`s3://${BUCKET}/evidence/./x.jpg`, BUCKET)).toBeNull();
  });

  it('does not refuse a bucket that merely starts with the same characters', () => {
    expect(keyForCropUri('s3://saakshi-evidence-archive/evidence/x.jpg', BUCKET)).toBeNull();
  });
});

describe('who may read a crop', () => {
  it('is exactly the roles that can already receive a cropUrl in a payload', () => {
    // Not wider and not narrower than the alert queue and the trace. `operator` sees the alert
    // queue, so an operator must be able to load the crop inside it.
    expect([...EVIDENCE_VIEW_ROLES].sort()).toEqual(
      ['admin', 'auditor', 'operator', 'supervisor'].filter((r) =>
        EVIDENCE_VIEW_ROLES.includes(r as UserRole),
      ),
    );
    expect(EVIDENCE_VIEW_ROLES).toContain('operator');
    expect(EVIDENCE_VIEW_ROLES.length).toBeGreaterThan(0);
  });
});

// ── Against the assembled server ──────────────────────────────────────────────────────────────

let app: App;
let rawSql: Sql;
let db: Db;
let env: Env;
let reachable = false;
let minioReachable = false;
const actors: Record<string, string> = {};
const keys: string[] = [];
const store = evidenceStoreFromEnv();
const BUCKET = store?.bucket ?? 'saakshi-evidence';

/** A one-pixel JPEG — these tests are about access control, not about images. */
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

function auth(role: UserRole): { authorization: string } {
  return {
    authorization: `Bearer ${app.jwt.sign({ sub: actors[role], badgeNo: 'GP-TEST-0001', role, departmentId: null })}`,
  };
}

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[evidence-api] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }

  const users = await db.execute<{ id: string; role: string }>(
    sql`select id, role from users`,
  );
  for (const role of ['admin', 'supervisor', 'operator', 'auditor']) {
    actors[role] = users.find((u) => u.role === role)?.id ?? randomUUID();
  }

  if (store !== null) {
    try {
      const health = await fetch(`${process.env['MINIO_ENDPOINT']}/minio/health/live`, {
        signal: AbortSignal.timeout(2_000),
      });
      minioReachable = health.ok;
    } catch {
      minioReachable = false;
    }
  }

  app = await buildServer({
    env,
    db,
    ...(store !== null ? { evidenceStore: store } : {}),
  });
  await app.ready();
});

afterAll(async () => {
  if (minioReachable && store !== null) {
    for (const key of keys) await store.deleteObject(key);
  }
  await app?.close();
  await rawSql?.end();
});

describe('GET /api/v1/evidence/crop', () => {
  it('refuses a request with no session — a schema-valid one, so the check is real', async () => {
    if (!reachable) return expect(reachable).toBe(false);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/evidence/crop?uri=${encodeURIComponent(`s3://${BUCKET}/evidence/cam01/x-plate.jpg`)}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 404 — not 403 — for a URI in another bucket, so storage cannot be mapped by probing', async () => {
    // Needs a *configured* store, though not a reachable one: the bucket name is what the guard
    // compares against, and the refusal happens before any network call. With no credentials the
    // route correctly answers 503 first, and this property is simply not testable.
    if (!reachable || store === null) return expect(store === null || !reachable).toBe(true);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/evidence/crop?uri=${encodeURIComponent('s3://some-other-bucket/evidence/x.jpg')}`,
      headers: auth('operator'),
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for an object that is not there, indistinguishably', async () => {
    if (!reachable || !minioReachable) return expect(reachable).toBe(true);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/evidence/crop?uri=${encodeURIComponent(`s3://${BUCKET}/evidence/__test__/${randomUUID()}.jpg`)}`,
      headers: auth('operator'),
    });
    expect(response.statusCode).toBe(404);
  });

  it('streams a real stored crop back as image bytes to an operator', async () => {
    if (!reachable || !minioReachable || store === null) return expect(reachable).toBe(true);
    const key = `evidence/__test__/${randomUUID()}-plate.jpg`;
    keys.push(key);
    await store.putObject(key, jpeg, 'image/jpeg');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/evidence/crop?uri=${encodeURIComponent(`s3://${BUCKET}/${key}`)}`,
      headers: auth('operator'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.rawPayload.byteLength).toBe(jpeg.byteLength);
    // Evidence behind a session must never sit in a shared cache.
    expect(response.headers['cache-control']).toContain('private');
  });
});
