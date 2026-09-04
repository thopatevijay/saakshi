import 'dotenv/config';
import { loadEnv } from './env.js';
import { buildServer } from './server.js';

const env = loadEnv();
const app = buildServer(env);

try {
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
