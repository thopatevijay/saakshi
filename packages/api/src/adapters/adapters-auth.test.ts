/**
 * The credentials-vs-connectivity regression.
 *
 * This suite exists because of one specific failure mode: an expired session cookie reported as
 * "camera unreachable". A control room seeing that dispatches a technician to a camera that is
 * working perfectly, while the actual fault — a token that needs refreshing — stays invisible. At
 * 80,000 cameras that is not a cosmetic bug, it is a maintenance budget spent on nothing.
 *
 * Run as the gate does, to prove it against the real gateway:
 *
 *   SENTINEL_PORTAL_COOKIE=sentinel=bogus npm run test -w packages/api -- adapters-auth
 *
 * It passes either way: the bad-cookie cases construct their own deliberately wrong credentials
 * rather than reading the environment, so the assertion does not depend on how the suite was
 * invoked.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthError, UnreachableError, createHlsAdapter } from './index.js';
import { loadEnv } from '../env.js';
import type { AdapterCameraConfig } from './types.js';

const env = loadEnv();
const HOST = env.SENTINEL_HOST;
const liveAvailable = HOST !== undefined && HOST !== '';

describe.skipIf(!liveAvailable)('a bad cookie against the real gateway is an AuthError', () => {
  const cfg = (camera: string): AdapterCameraConfig => ({
    externalId: camera,
    adapterKind: 'hls',
    endpoints: { hls: `https://${HOST ?? ''}/${camera}/index.m3u8` },
  });

  it('rejects with AuthError, not UnreachableError', async () => {
    // Deliberately wrong, and constructed here rather than read from the environment so the
    // assertion holds however the suite was invoked.
    const adapter = createHlsAdapter({ cookie: 'sentinel=deliberately-invalid-token' });

    await expect(adapter.probe(cfg('cam01'))).rejects.toThrow(AuthError);
    await expect(adapter.probe(cfg('cam01'))).rejects.not.toThrow(UnreachableError);
  }, 120_000);

  it('says the camera may be fine, so nobody dispatches a technician', async () => {
    const adapter = createHlsAdapter({ cookie: 'sentinel=deliberately-invalid-token' });
    await expect(adapter.probe(cfg('cam01'))).rejects.toThrow(/session|token/i);
    await expect(adapter.probe(cfg('cam01'))).rejects.toThrow(/camera itself may be fine/i);
  }, 120_000);

  it('no cookie at all is also an AuthError — every sandbox path is gated', async () => {
    const adapter = createHlsAdapter({});
    await expect(adapter.probe(cfg('cam01'))).rejects.toThrow(AuthError);
  }, 120_000);

  it('health() surfaces the auth failure but still reports the camera as connectable', async () => {
    // The distinction the whole taxonomy exists for: the network reached the camera, so
    // `connectable` is true; the credentials were refused, so `decodable` is false and the error
    // names the real problem. A prober that wrote `connectable: false` here would be lying.
    const adapter = createHlsAdapter({ cookie: 'sentinel=deliberately-invalid-token' });
    const sample = await adapter.health(cfg('cam01'));

    expect(sample.connectable).toBe(true);
    expect(sample.decodable).toBe(false);
    expect(sample.error).toMatch(/AuthError/);
  }, 120_000);
});

/**
 * The same distinction, without the network — so it is verifiable offline and in CI.
 *
 * A local server that answers exactly as the gateway does (302 to a login page for an
 * unauthenticated request) versus a port with nothing on it.
 */
describe('credentials versus connectivity, verified locally', () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const cookie = req.headers.cookie ?? '';
      // Exactly what the sandbox does: an unauthenticated request is answered with a redirect to a
      // login page, not a 401. ffmpeg follows it and then fails to parse HTML as a playlist, which
      // is why naive classification calls this a decode error.
      if (!cookie.includes('sentinel=valid')) {
        res.writeHead(302, { location: '/login' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-ENDLIST\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a 302 to a login page is an AuthError, not a decode failure', async () => {
    const adapter = createHlsAdapter({ cookie: 'sentinel=wrong' });
    await expect(
      adapter.probe({
        externalId: 'local',
        adapterKind: 'hls',
        endpoints: { hls: `http://127.0.0.1:${String(port)}/index.m3u8` },
      }),
    ).rejects.toThrow(AuthError);
  }, 30_000);

  it('a port with nothing listening is an UnreachableError', async () => {
    const adapter = createHlsAdapter({ cookie: 'sentinel=valid' });
    await expect(
      adapter.probe({
        externalId: 'dead',
        adapterKind: 'hls',
        // Port 1 is reserved; nothing listens there.
        endpoints: { hls: 'http://127.0.0.1:1/index.m3u8' },
      }),
    ).rejects.toThrow(UnreachableError);
  }, 30_000);

  it('the two failures are distinguishable by class, which is the entire point', async () => {
    const badCookie = createHlsAdapter({ cookie: 'sentinel=wrong' });
    const deadHost = createHlsAdapter({ cookie: 'sentinel=valid' });

    const authFailure = await badCookie
      .probe({
        externalId: 'local',
        adapterKind: 'hls',
        endpoints: { hls: `http://127.0.0.1:${String(port)}/index.m3u8` },
      })
      .catch((e: unknown) => e);
    const reachFailure = await deadHost
      .probe({ externalId: 'dead', adapterKind: 'hls', endpoints: { hls: 'http://127.0.0.1:1/i.m3u8' } })
      .catch((e: unknown) => e);

    expect((authFailure as Error).name).toBe('AuthError');
    expect((reachFailure as Error).name).toBe('UnreachableError');
    expect((authFailure as Error).name).not.toBe((reachFailure as Error).name);
  }, 30_000);
});
