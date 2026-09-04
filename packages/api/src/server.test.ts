import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type App } from './server.js';
import { loadEnv } from './env.js';

describe('GET /health', () => {
  let app: App;

  beforeAll(async () => {
    // No `db`, so the registry routes are not registered: health must not depend on a database.
    app = await buildServer({ env: loadEnv({ NODE_ENV: 'test' }) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with the service identity', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'saakshi-api' });
  });

  it('needs no authentication — it is a liveness probe', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

describe('loadEnv', () => {
  it('defaults API_PORT to 4000', () => {
    expect(loadEnv({ NODE_ENV: 'test' }).API_PORT).toBe(4000);
  });

  it('rejects an unknown query compiler provider', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', QUERY_COMPILER: 'gemini' })).toThrow(/QUERY_COMPILER/);
  });

  it('rejects a JWT secret that is too short to be one', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });
});
