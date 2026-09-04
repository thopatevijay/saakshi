/**
 * Session issuance tests.
 *
 * Against the real seeded users and the real bcrypt hashes, because the thing most likely to be
 * wrong here is the password comparison itself, and a mocked one proves nothing about pgcrypto.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildServer, type App } from '../server.js';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';

const PASSWORD = 'saakshi-dev';
const TAG = `AUTH-${String(Date.now())}`;

let app: App;
let rawSql: Sql;
let db: Db;
let env: Env;
let reachable = false;

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[auth] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }
  app = await buildServer({ env, db });
  await app.ready();
});

afterAll(async () => {
  if (reachable) {
    await db.execute(sql`delete from users where badge_no like ${`${TAG}%`}`);
  }
  await app?.close();
  await rawSql?.end();
});

const login = (badgeNo: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { badgeNo, password } });

describe('POST /api/v1/auth/login', () => {
  it.each([
    ['GP-ADM-0001', 'admin'],
    ['GP-SUP-0100', 'supervisor'],
    ['GP-OPR-1042', 'operator'],
    ['GP-AUD-0007', 'auditor'],
  ])('logs in %s as %s', async (badgeNo, role) => {
    if (!reachable) return;
    const res = await login(badgeNo, PASSWORD);

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      token: string;
      expiresInSeconds: number;
      user: { badgeNo: string; role: string; capabilities: string[] };
    }>();

    expect(body.user.badgeNo).toBe(badgeNo);
    expect(body.user.role).toBe(role);
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.expiresInSeconds).toBeGreaterThan(0);
    // The UI renders from the same matrix the server enforces rather than its own copy.
    expect(body.user.capabilities).toContain('registry:read');
  });

  it('the issued token actually works against a protected endpoint', async () => {
    if (!reachable) return;
    const { token } = (await login('GP-OPR-1042', PASSWORD)).json<{ token: string }>();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cameras?limit=1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong password cleanly', async () => {
    if (!reachable) return;
    const res = await login('GP-ADM-0001', 'not-the-password');

    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: string; message: string }>();
    expect(body.error).toBe('unauthorized');
    // Clean: a message, not a stack trace and not a hint about which half was wrong.
    expect(body.message).toBe('badge number or password is incorrect');
    expect(JSON.stringify(body)).not.toContain('crypt');
  });

  it('gives an unknown badge the same answer as a wrong password', async () => {
    if (!reachable) return;
    // Different responses here would turn the endpoint into an oracle for valid badge numbers.
    const unknown = await login('GP-NOBODY-9999', PASSWORD);
    const wrongPassword = await login('GP-ADM-0001', 'nope');

    expect(unknown.statusCode).toBe(wrongPassword.statusCode);
    expect(unknown.json()).toEqual(wrongPassword.json());
  });

  it('refuses a deactivated account, and says nothing more than that', async () => {
    if (!reachable) return;
    const badge = `${TAG}-INACTIVE`;
    await db.execute(sql`
      insert into users (name, badge_no, role, password_hash, active)
      values ('Deactivated Officer', ${badge}, 'operator', crypt(${PASSWORD}, gen_salt('bf')), false)`);

    const res = await login(badge, PASSWORD);
    expect(res.statusCode).toBe(401);
    // Deactivating an officer genuinely revokes access — the correct password no longer works.
    expect(res.json<{ message: string }>().message).toBe('badge number or password is incorrect');
  });

  it('rejects a malformed body with field-level detail', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { badgeNo: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('validation_failed');
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns the signed-in user and their capabilities', async () => {
    if (!reachable) return;
    const { token } = (await login('GP-AUD-0007', PASSWORD)).json<{ token: string }>();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ role: string; badgeNo: string; capabilities: string[] }>();
    expect(body.role).toBe('auditor');
    expect(body.badgeNo).toBe('GP-AUD-0007');
    // The auditor's deliberate exclusions, asserted where somebody will notice if they change.
    expect(body.capabilities).toContain('audit:read');
    expect(body.capabilities).not.toContain('video:view');
    expect(body.capabilities).not.toContain('registry:write');
  });

  it('401s without a token', async () => {
    if (!reachable) return;
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
  });
});

describe('the server is authoritative — RBAC is not a UI concern', () => {
  it('an operator token is refused on a supervisor-only endpoint', async () => {
    if (!reachable) return;
    const { token } = (await login('GP-OPR-1042', PASSWORD)).json<{ token: string }>();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${token}` },
      payload: { externalId: `${TAG}-denied`, name: 'Should not exist', adapterKind: 'hls' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ allowed: string[] }>().allowed).toEqual(['admin', 'supervisor']);
  });

  it('a supervisor token is refused on an admin-only delete', async () => {
    if (!reachable) return;
    const { token } = (await login('GP-SUP-0100', PASSWORD)).json<{ token: string }>();

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/cameras/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
