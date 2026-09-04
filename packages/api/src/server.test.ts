import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';
import { loadEnv } from './env.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer(loadEnv({ NODE_ENV: 'test' }));
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
});

describe('loadEnv', () => {
  it('defaults API_PORT to 4000', () => {
    expect(loadEnv({ NODE_ENV: 'test' }).API_PORT).toBe(4000);
  });

  it('rejects an unknown query compiler provider', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', QUERY_COMPILER: 'gemini' })).toThrow(/QUERY_COMPILER/);
  });
});
