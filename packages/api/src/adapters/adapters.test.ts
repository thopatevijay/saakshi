/**
 * Adapter framework — core suite.
 *
 * Covers the parts that must hold regardless of what is reachable: interface conformance, the exact
 * ffmpeg argv (so the auth/UA requirement is *asserted*, not assumed), backoff, extensibility, and
 * the HLS adapter against the real sandbox.
 *
 * The live HLS tests skip loudly when `SENTINEL_PORTAL_COOKIE` is unset, because a fresh clone
 * without portal credentials should still be able to run the suite — but they do **not** skip when
 * the cookie is present and merely wrong. That case is a failure, and `adapters-auth.test.ts` is
 * where it is asserted.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  AuthError,
  BROWSER_UA,
  backoffDelayMs,
  backoffSequenceMs,
  createAdapterRegistry,
  createFileAdapter,
  createHlsAdapter,
  createNvrAdapter,
  createOnvifAdapter,
  createRtspAdapter,
  createWhepAdapter,
  extractFrameArgs,
  httpInputArgs,
  isHttpUrl,
  NotImplementedError,
  probeArgs,
  streamArgs,
  withBackoff,
  type AdapterCameraConfig,
  type CameraAdapter,
  type CameraCapabilities,
} from './index.js';
import { classifyFfmpegError, measureFpsArgs } from './ffmpeg.js';
import { loadEnv } from '../env.js';

const env = loadEnv();
const COOKIE = env.SENTINEL_PORTAL_COOKIE;
const HOST = env.SENTINEL_HOST;
const liveAvailable = COOKIE !== undefined && COOKIE !== '' && HOST !== undefined && HOST !== '';

const hlsCfg = (camera: string): AdapterCameraConfig => ({
  externalId: camera,
  adapterKind: 'hls',
  endpoints: { hls: `https://${HOST ?? 'localhost'}/${camera}/index.m3u8` },
});

// ── Interface conformance ───────────────────────────────────────────────────────────────────────

describe('registry and interface conformance', () => {
  const registry = createAdapterRegistry({ SENTINEL_PORTAL_COOKIE: COOKIE });

  it('registers exactly the six transports the adapter_kind enum allows', () => {
    // Keyed to db/migrations/0002_enums.up.sql. A transport the database cannot store is a
    // transport the registry must not offer.
    expect(registry.kinds().sort()).toEqual(['file', 'hls', 'nvr', 'onvif', 'rtsp', 'whep']);
  });

  it.each(['hls', 'rtsp', 'onvif', 'whep', 'file', 'nvr'] as const)(
    '%s implements every interface method and declares an honest status',
    (kind) => {
      const adapter = registry.get(kind);
      expect(adapter.kind).toBe(kind);
      for (const method of ['probe', 'open', 'close', 'health'] as const) {
        expect(typeof adapter[method], `${kind}.${method}`).toBe('function');
      }
      expect(adapter.description.length).toBeGreaterThan(10);
      expect(['operational', 'demonstrated', 'stub']).toContain(adapter.status);
    },
  );

  it('throws a useful error for an unregistered transport rather than returning undefined', () => {
    expect(() => registry.get('carrier-pigeon')).toThrow(NotImplementedError);
    expect(() => registry.get('carrier-pigeon')).toThrow(/registered: /);
  });

  it('derives the transport table from the code, so docs cannot drift from reality', () => {
    const table = registry.transportTable();
    const byKind = Object.fromEntries(table.map((t) => [t.kind, t.status]));

    // The honesty guarantee. hls/file are verified against the real feed; rtsp/onvif/whep are
    // verified against local MediaMTX only, because the sandbox serves no such transport.
    expect(byKind).toEqual({
      hls: 'operational',
      file: 'operational',
      rtsp: 'demonstrated',
      onvif: 'demonstrated',
      whep: 'demonstrated',
      nvr: 'stub',
    });
  });
});

// ── The Model 4 claim, made checkable ───────────────────────────────────────────────────────────

describe('adding a sixth adapter touches nothing outside its own file', () => {
  it('registers and drives a throwaway adapter through the same code path', async () => {
    // This test *is* the "onboarding a vendor means one file plus one registry line" claim. If it
    // ever needs a change anywhere else in the codebase to pass, the claim has become false.
    const nullAdapter: CameraAdapter = {
      kind: 'file', // reuses an enum slot; a real sixth transport would add one enum value
      description: 'Throwaway adapter proving the registry needs no knowledge of its internals',
      status: 'stub',
      probe: (): Promise<CameraCapabilities> =>
        Promise.resolve({
          transport: 'file',
          reachable: true,
          decodable: true,
          codec: 'test',
          width: 2,
          height: 1,
          measuredFps: 1,
          declaredFps: null,
          durationS: 1,
          seekable: false,
          encrypted: false,
          probeMs: 0,
          probedAt: new Date().toISOString(),
        }),
      open: () =>
        Promise.resolve({
          cameraId: 'x',
          transport: 'file' as const,
          url: 'null://',
          startOffsetS: 0,
          stdout: null,
          closed: Promise.resolve(0),
          close: () => Promise.resolve(),
        }),
      close: () => Promise.resolve(),
      health: () =>
        Promise.resolve({
          transport: 'file' as const,
          connectable: true,
          decodable: true,
          measuredFps: 1,
          actualResolution: '2x1',
          actualCodec: 'test',
          latencyMs: 0,
          error: null,
          checkedAt: new Date().toISOString(),
        }),
    };

    // One line. That is the entire integration surface.
    const registry = new AdapterRegistry().register(nullAdapter);

    const caps = await registry.get('file').probe({
      externalId: 'throwaway',
      adapterKind: 'file',
      endpoints: {},
    });
    expect(caps.codec).toBe('test');
    expect(caps.transport).toBe('file');
  });
});

// ── ffmpeg argv: the auth requirement, asserted ─────────────────────────────────────────────────

describe('ffmpeg argv carries auth and a browser User-Agent', () => {
  const auth = { cookie: 'sentinel=abc123' };

  it('injects the cookie header and a browser UA, with the CRLF ffmpeg requires', () => {
    const args = httpInputArgs(auth);
    expect(args).toContain('-user_agent');
    expect(args[args.indexOf('-user_agent') + 1]).toBe(BROWSER_UA);
    expect(args).toContain('-headers');
    // The trailing CRLF is not cosmetic: without it ffmpeg corrupts the request when it appends
    // further headers.
    expect(args[args.indexOf('-headers') + 1]).toBe('Cookie: sentinel=abc123\r\n');
  });

  it('sends a browser UA even with no cookie — Cloudflare 403s ffmpeg\'s default either way', () => {
    const args = httpInputArgs({});
    expect(args[args.indexOf('-user_agent') + 1]).toBe(BROWSER_UA);
    expect(args).not.toContain('-headers');
  });

  it.each([
    ['probe', probeArgs('https://h/c/index.m3u8', auth)],
    ['measure fps', measureFpsArgs('https://h/c/index.m3u8', auth, { windowS: 4 })],
    ['extract frame', extractFrameArgs('https://h/c/index.m3u8', auth, { seekS: 100, outPath: '/tmp/x.jpg' })],
    ['stream', streamArgs('https://h/c/index.m3u8', auth, { format: 'rawvideo' })],
  ])('%s argv includes both auth options', (_name, args) => {
    expect(args).toContain('-headers');
    expect(args).toContain('-user_agent');
  });

  it('places -ss before -i so a seek is an input seek, not decode-and-discard', () => {
    // On a 12-hour VOD playlist this is the difference between one second and one hour.
    const args = measureFpsArgs('https://h/c/index.m3u8', auth, { seekS: 39600, windowS: 4 });
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('39600');
  });

  it('forces RTSP over TCP — UDP drops RTP packets silently', () => {
    const args = streamArgs('rtsp://h/c', {}, { format: 'rawvideo', rtspTransportTcp: true });
    expect(args).toContain('-rtsp_transport');
    expect(args[args.indexOf('-rtsp_transport') + 1]).toBe('tcp');
  });

  it('omits HTTP-only options for non-HTTP inputs', () => {
    // Regression. `-reconnect` is an HTTP-demuxer option: passing it to an RTSP input makes ffmpeg
    // exit instantly with `Option reconnect not found`, so the RTSP adapter opened a stream that
    // produced no frames at all. Caught by the MediaMTX suite, which is precisely why that suite
    // must fail loudly rather than skip.
    for (const url of ['rtsp://127.0.0.1:8554/x', '/tmp/clip.mp4']) {
      const args = streamArgs(url, { cookie: 'sentinel=x' }, { format: 'rawvideo' });
      expect(args, url).not.toContain('-reconnect');
      expect(args, url).not.toContain('-headers');
      expect(args, url).not.toContain('-user_agent');
    }
  });

  it('still applies HTTP options when the input is HTTP', () => {
    const args = streamArgs('https://h/c/index.m3u8', { cookie: 'sentinel=x' }, { format: 'rawvideo' });
    expect(args).toContain('-reconnect');
    expect(args).toContain('-headers');
  });

  it('isHttpUrl distinguishes the schemes the flags depend on', () => {
    expect(isHttpUrl('https://h/x')).toBe(true);
    expect(isHttpUrl('http://h/x')).toBe(true);
    expect(isHttpUrl('rtsp://h/x')).toBe(false);
    expect(isHttpUrl('/tmp/clip.mp4')).toBe(false);
  });
});

/**
 * Proves the header reaches the playlist, the AES key **and** the segments.
 *
 * Asserting the argv shows what we asked ffmpeg for; this shows what ffmpeg actually sent. The
 * distinction matters because the sandbox 302s all three paths without a cookie, so auth applied
 * only to the playlist would fail at the first key fetch — with a decode error that looks like a
 * broken camera.
 */
describe('auth reaches playlist, key and segment requests', () => {
  let server: Server;
  let port = 0;
  const seen: { path: string; cookie: string | undefined; ua: string | undefined }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({
        path: req.url ?? '',
        cookie: req.headers.cookie,
        ua: req.headers['user-agent'],
      });

      if (req.url === '/index.m3u8') {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end(
          [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            '#EXT-X-TARGETDURATION:1',
            '#EXT-X-PLAYLIST-TYPE:VOD',
            '#EXT-X-KEY:METHOD=AES-128,URI="/enc.key",IV=0x' + '0'.repeat(32),
            '#EXTINF:1.0,',
            '/seg0.ts',
            '#EXT-X-ENDLIST',
            '',
          ].join('\n'),
        );
        return;
      }
      if (req.url === '/enc.key') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.alloc(16, 7));
        return;
      }
      if (req.url === '/seg0.ts') {
        // Not real video — ffmpeg will fail to decode it, which is fine: by then it has already
        // made the three requests this test exists to observe.
        res.writeHead(200, { 'content-type': 'video/mp2t' });
        res.end(Buffer.alloc(2048, 0));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends the cookie and browser UA on all three request types', async () => {
    const adapter = createHlsAdapter({ cookie: 'sentinel=observed-token' });
    const cfg: AdapterCameraConfig = {
      externalId: 'local-probe',
      adapterKind: 'hls',
      endpoints: { hls: `http://127.0.0.1:${String(port)}/index.m3u8` },
    };

    // Expected to reject — the fake segment is not decodable. The requests are the assertion.
    await adapter.probe(cfg).catch(() => undefined);

    const paths = seen.map((s) => s.path);
    expect(paths).toContain('/index.m3u8');
    expect(paths, 'ffmpeg must fetch the AES-128 key').toContain('/enc.key');
    expect(paths, 'ffmpeg must fetch at least one segment').toContain('/seg0.ts');

    // Every single request, not just the first.
    for (const request of seen) {
      expect(request.cookie, `cookie missing on ${request.path}`).toBe('sentinel=observed-token');
      expect(request.ua, `browser UA missing on ${request.path}`).toBe(BROWSER_UA);
    }
  });
});

// ── Error taxonomy ──────────────────────────────────────────────────────────────────────────────

describe('error classification distinguishes credentials from connectivity', () => {
  it.each([
    ['HTTP error 401 Unauthorized', 'AuthError'],
    ['HTTP error 403 Forbidden', 'AuthError'],
    ['Invalid data found when processing input', 'AuthError'],
    ['Connection refused', 'UnreachableError'],
    ['Failed to resolve hostname cctv.example', 'UnreachableError'],
    ['HTTP error 404 Not Found', 'UnreachableError'],
    ['Could not find codec parameters', 'DecodeError'],
  ])('%s -> %s', (stderr, expected) => {
    // An expired cookie reported as "camera down" sends a technician to a working camera. This
    // mapping is the reason the taxonomy exists.
    expect(classifyFfmpegError(stderr, 'cam01', 'hls').name).toBe(expected);
  });
});

// ── Backoff ─────────────────────────────────────────────────────────────────────────────────────

describe('reconnect backoff: 2s doubling to a 30s cap', () => {
  it('produces exactly 2s, 4s, 8s, 16s, 30s, 30s', () => {
    // 32s would exceed the cap, so it clamps and stays. A tight reconnect loop against a
    // government gateway is indistinguishable from an attack.
    expect(backoffSequenceMs(6)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('never exceeds the cap however many attempts have failed', () => {
    for (const attempt of [6, 10, 50, 1_000]) {
      expect(backoffDelayMs(attempt)).toBe(30_000);
    }
  });

  it('applies jitter downward only, so the cap still holds', () => {
    for (let i = 0; i < 50; i += 1) {
      const delay = backoffDelayMs(10, 0.2);
      expect(delay).toBeLessThanOrEqual(30_000);
      expect(delay).toBeGreaterThanOrEqual(24_000);
    }
  });

  it('retries a transport failure and recovers, sleeping the exact sequence', async () => {
    const slept: number[] = [];
    let attempts = 0;

    const result = await withBackoff(
      () => {
        attempts += 1;
        if (attempts < 4) return Promise.reject(new Error('stream interrupted'));
        return Promise.resolve('recovered');
      },
      {
        jitter: 0,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      },
    );

    expect(result).toBe('recovered');
    expect(attempts).toBe(4);
    expect(slept).toEqual([2_000, 4_000, 8_000]);
  });

  it('does not retry an AuthError — a rejected cookie is still rejected 30s later', async () => {
    const slept: number[] = [];
    await expect(
      withBackoff(() => Promise.reject(new AuthError('bad cookie', 'cam01', 'hls')), {
        jitter: 0,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
        shouldRetry: (error) => !(error instanceof AuthError),
      }),
    ).rejects.toThrow(AuthError);

    // Zero sleeps: retrying would be pure noise against the gateway.
    expect(slept).toEqual([]);
  });
});

// ── The nvr stub ────────────────────────────────────────────────────────────────────────────────

describe('the nvr adapter is an honest stub', () => {
  const nvr = createNvrAdapter();
  const cfg: AdapterCameraConfig = { externalId: 'nvr-1', adapterKind: 'nvr', endpoints: {} };

  it('declares itself a stub', () => {
    expect(nvr.status).toBe('stub');
    expect(nvr.description).toMatch(/STUB/);
  });

  it('rejects probe and open with a message that says why, naming the missing SDK', async () => {
    // A stub that silently returned empty capabilities would look like support, and a department
    // would onboard cameras that quietly never produce a frame.
    await expect(nvr.probe(cfg)).rejects.toThrow(NotImplementedError);
    await expect(nvr.probe(cfg)).rejects.toThrow(/vendor SDK/);
    await expect(nvr.open(cfg)).rejects.toThrow(NotImplementedError);
  });

  it('reports its own unavailability through health() rather than crashing a sweep', async () => {
    const sample = await nvr.health(cfg);
    expect(sample.connectable).toBe(false);
    expect(sample.error).toMatch(/NotImplementedError/);
  });
});

// ── The file adapter ────────────────────────────────────────────────────────────────────────────

describe('file adapter', () => {
  const clip = path.join(tmpdir(), `saakshi-adapter-${String(process.pid)}.mp4`);

  beforeAll(async () => {
    const { run } = await import('./ffmpeg.js');
    // 2s of 320x240 at 10 fps — small, fast, and a known-good answer to compare against.
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=10:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      clip,
    ]);
  });

  afterAll(async () => {
    await rm(clip, { force: true });
  });

  it('probes a real clip and measures its properties', async () => {
    const adapter = createFileAdapter();
    const caps = await adapter.probe({
      externalId: 'clip-1',
      adapterKind: 'file',
      endpoints: { file: clip },
    });

    expect(caps.transport).toBe('file');
    expect(caps.codec).toBe('h264');
    expect(caps.width).toBe(320);
    expect(caps.height).toBe(240);
    expect(caps.measuredFps).toBeCloseTo(10, 0);
    expect(caps.seekable).toBe(true);
  });

  it('reports a missing file as unreachable, not as a decode failure', async () => {
    const adapter = createFileAdapter();
    const sample = await adapter.health({
      externalId: 'ghost',
      adapterKind: 'file',
      endpoints: { file: '/nonexistent/nope.mp4' },
    });
    expect(sample.connectable).toBe(false);
    expect(sample.error).toMatch(/UnreachableError/);
  });
});

// ── Missing endpoints ───────────────────────────────────────────────────────────────────────────

describe('a camera with no endpoint for its transport fails clearly', () => {
  it.each([
    ['hls', createHlsAdapter()],
    ['rtsp', createRtspAdapter()],
    ['onvif', createOnvifAdapter()],
    ['whep', createWhepAdapter()],
  ])('%s names the missing endpoint key', async (kind, adapter) => {
    await expect(
      adapter.probe({ externalId: 'cam-x', adapterKind: kind as 'hls', endpoints: {} }),
    ).rejects.toThrow(new RegExp(`no '${kind}' (service )?endpoint`));
  });
});

// ── Live HLS against the government feed ────────────────────────────────────────────────────────

describe.skipIf(!liveAvailable)('HLS adapter against the real Sentinel sandbox', () => {
  const adapter = createHlsAdapter({ cookie: COOKIE });
  const probes = new Map<string, CameraCapabilities>();

  it(
    'probes cam01 and returns measured capabilities',
    async () => {
      const caps = await adapter.probe(hlsCfg('cam01'));
      probes.set('cam01', caps);

      expect(caps.transport).toBe('hls');
      expect(caps.reachable).toBe(true);
      expect(caps.decodable).toBe(true);
      expect(caps.codec).toBe('h264');
      expect(caps.width).toBe(1920);
      expect(caps.height).toBe(1080);
      expect(caps.measuredFps).toBeGreaterThan(0);
      // VOD with ENDLIST, AES-128 — exactly what recon found, and both are load-bearing.
      expect(caps.seekable).toBe(true);
      expect(caps.encrypted).toBe(true);
      expect(caps.durationS).toBeGreaterThan(3_600);
    },
    900_000,
  );

  it(
    'probes cam12 and returns a different resolution — the estate is genuinely heterogeneous',
    async () => {
      const caps = await adapter.probe(hlsCfg('cam12'));
      probes.set('cam12', caps);

      expect(caps.codec).toBe('h264');
      expect(caps.width).toBe(1280);
      expect(caps.height).toBe(720);
      expect(caps.measuredFps).toBeGreaterThan(0);
    },
    900_000,
  );

  it('the two cameras differ in resolution, which is why nothing may be assumed estate-wide', () => {
    const a = probes.get('cam01');
    const b = probes.get('cam12');
    if (a === undefined || b === undefined) return;
    expect(`${String(a.width)}x${String(a.height)}`).not.toBe(`${String(b.width)}x${String(b.height)}`);
  });

  it(
    'measured fps disagrees with the container header — the reason measurement exists',
    () => {
      const caps = probes.get('cam01');
      if (caps === undefined) return;
      // cam01's header claims 30 fps; independently verified at ~15 fps of actual content
      // (151 frames per 10 s), with irregular PTS spacing. Pillar 1's whole argument, on their
      // own feed. Asserted as a *relationship*, not a fixed number, so a re-encoded feed does not
      // fail the suite spuriously.
      expect(caps.declaredFps).not.toBeNull();
      expect(caps.measuredFps).not.toBeNull();
      expect(caps.measuredFps).toBeLessThan(caps.declaredFps ?? Infinity);
    },
  );

  it(
    'seeks to an arbitrary offset and returns a frame genuinely from that point',
    async () => {
      const seekPath = path.join(tmpdir(), `saakshi-seek-${String(process.pid)}.jpg`);
      const startPath = path.join(tmpdir(), `saakshi-start-${String(process.pid)}.jpg`);
      try {
        // Offset 39600 is 11.0h into a 12.0h recording. Proving the seek landed is done by
        // *comparing frames*, not by brightness: cam01 is a street-lit bridge, so its night
        // footage is not dark (measured YAVG 100 at offset 0 versus 138 at 39600 — a real
        // difference, but far too weak to rest a claim on). If seeking silently failed, ffmpeg
        // would hand back the first frame of the file, so two different images is the proof.
        await adapter.extractFrame(hlsCfg('cam01'), 39_600, seekPath);
        await adapter.extractFrame(hlsCfg('cam01'), 0, startPath);

        const seeked = await readFile(seekPath);
        const start = await readFile(startPath);

        // Valid JPEGs: SOI marker.
        for (const bytes of [seeked, start]) {
          expect(bytes.byteLength).toBeGreaterThan(5_000);
          expect(bytes[0]).toBe(0xff);
          expect(bytes[1]).toBe(0xd8);
        }

        const digest = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
        expect(
          digest(seeked),
          'the seeked frame is byte-identical to the start of the file — the seek did not land',
        ).not.toBe(digest(start));
      } finally {
        await rm(seekPath, { force: true });
        await rm(startPath, { force: true });
      }
    },
    // Generous: a 7,200-segment playlist over a throttled gateway measured 295s for one probe.
    900_000,
  );

  it(
    'health() reports a live camera as connectable and decodable',
    async () => {
      const sample = await adapter.health(hlsCfg('cam01'));
      expect(sample.connectable).toBe(true);
      expect(sample.decodable).toBe(true);
      expect(sample.actualResolution).toBe('1920x1080');
      expect(sample.error).toBeNull();
    },
    900_000,
  );
});

describe('a timeout is not a verdict on the stream', () => {
  it('classifies a killed process as TimeoutError, never DecodeError', () => {
    // The defect this guards against: under load the sandbox took 295s for a probe that had taken
    // 27s an hour earlier, so ffmpeg was killed by its deadline — and the partial stderr was being
    // read as "the stream is not decodable". That would condemn a working camera for a slow
    // afternoon, and the trust score would carry the mistake forward.
    const killed = classifyFfmpegError('partial output, then SIGKILL', 'cam01', 'hls', {
      timedOut: true,
      elapsedMs: 295_000,
    });
    expect(killed.name).toBe('TimeoutError');
    expect(killed.message).toMatch(/not evidence the stream is bad/);
    expect(killed.message).toMatch(/295s/);
  });

  it('still classifies a genuine decode failure when no timeout occurred', () => {
    const bad = classifyFfmpegError('Could not find codec parameters', 'cam01', 'hls', {
      timedOut: false,
      elapsedMs: 500,
    });
    expect(bad.name).toBe('DecodeError');
  });
});
