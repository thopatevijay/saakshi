import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type App, openapiServers } from './server.js';
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

describe('the published OpenAPI spec names a host a reader can actually call', () => {
  it('advertises PUBLIC_ORIGIN when it is set, with no trailing slash', () => {
    expect(
      openapiServers({
        API_PORT: 4000,
        PUBLIC_ORIGIN: 'https://api.example.gov.in/',
        RAILWAY_PUBLIC_DOMAIN: 'ignored.up.railway.app',
      }),
    ).toEqual([{ url: 'https://api.example.gov.in', description: 'deployed' }]);
  });

  it("falls back to Railway's injected domain, so the deployment needs no configuration", () => {
    expect(
      openapiServers({
        API_PORT: 8080,
        PUBLIC_ORIGIN: '',
        RAILWAY_PUBLIC_DOMAIN: 'saakshi-api.up.railway.app',
      }),
    ).toEqual([{ url: 'https://saakshi-api.up.railway.app', description: 'deployed' }]);
  });

  it('uses localhost only when there is no public origin at all', () => {
    expect(
      openapiServers({ API_PORT: 4000, PUBLIC_ORIGIN: '', RAILWAY_PUBLIC_DOMAIN: '' }),
    ).toEqual([{ url: 'http://localhost:4000', description: 'local' }]);
  });

  it('never advertises localhost on a deployment — the regression this exists for', () => {
    // The hosted spec said http://localhost:8080, because API_PORT there is the injected port.
    const servers = openapiServers({
      API_PORT: 8080,
      PUBLIC_ORIGIN: '',
      RAILWAY_PUBLIC_DOMAIN: 'saakshi-api.up.railway.app',
    });
    expect(servers[0]?.url).not.toContain('localhost');
  });
});
