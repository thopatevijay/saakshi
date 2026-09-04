import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './env.js';

export interface HealthResponse {
  status: 'ok';
  service: 'saakshi-api';
  version: string;
  uptimeS: number;
}

const VERSION = '0.1.0';

export function buildServer(env: Env): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : 'info',
      // Redaction is set up here, at the bootstrap, rather than remembered later.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  app.get('/health', (): HealthResponse => {
    return {
      status: 'ok',
      service: 'saakshi-api',
      version: VERSION,
      uptimeS: Math.round(process.uptime()),
    };
  });

  return app;
}
