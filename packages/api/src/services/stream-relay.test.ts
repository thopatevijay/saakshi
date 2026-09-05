import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  RelayConfigurationError,
  RelayUpstreamError,
  StreamRelay,
  assertRelayable,
  contentTypeFor,
  decodeUpstreamToken,
  encodeUpstreamToken,
  resolveUpstream,
  rewritePlaylist,
  type RelayCamera,
} from './stream-relay.js';

const camera = (over: Partial<RelayCamera> = {}): RelayCamera => ({
  externalId: 'cam01',
  adapterKind: 'hls',
  endpoints: {},
  ...over,
});

/** The real sandbox playlist head, byte for byte, captured 2026-09-05. */
const SANDBOX_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-TARGETDURATION:8',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-KEY:METHOD=AES-128,URI="/enc.key",IV=0x00000000000000000000000000000000',
  '#EXTINF:7.920000,',
  'seg00000.ts',
  '#EXTINF:6.006000,',
  'seg00001.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

describe('resolveUpstream', () => {
  it('prefers the registry endpoint for the camera’s own adapter kind', () => {
    const url = resolveUpstream(
      camera({ endpoints: { hls: 'https://vms.gov/a.m3u8', rtsp: 'rtsp://x' } }),
      { host: 'ignored.example' },
    );
    expect(url).toBe('https://vms.gov/a.m3u8');
  });

  it('falls back to a configured template, never a compiled-in pattern', () => {
    const url = resolveUpstream(camera({ externalId: 'cam12' }), {
      template: 'https://vms.gov/api/v2/{external_id}/live',
      host: 'sandbox.example',
    });
    expect(url).toBe('https://vms.gov/api/v2/cam12/live');
  });

  it('falls back to the configured host last', () => {
    expect(resolveUpstream(camera(), { host: 'sandbox.example' })).toBe(
      'https://sandbox.example/cam01/index.m3u8',
    );
  });

  it('is a configuration error, not a camera fault, when nothing resolves', () => {
    expect(() => resolveUpstream(camera(), {})).toThrow(RelayConfigurationError);
  });
});

describe('upstream tokens', () => {
  it('round-trips a URL', () => {
    const url = 'https://host.example/cam01/seg00000.ts?x=1';
    expect(decodeUpstreamToken(encodeUpstreamToken(url))).toBe(url);
  });

  it('rejects a token that is not the canonical encoding of its own content', () => {
    // base64 with padding/alphabet drift decodes to *something*; it must still be refused.
    expect(() => decodeUpstreamToken('!!!!')).toThrow(RelayUpstreamError);
  });
});

describe('assertRelayable — the SSRF guard', () => {
  const upstream = 'https://cctv.example.gov/cam01/index.m3u8';

  it('allows a target on the camera’s own origin', () => {
    expect(assertRelayable('https://cctv.example.gov/enc.key', upstream).pathname).toBe('/enc.key');
  });

  it('refuses another origin, however plausible', () => {
    expect(() => assertRelayable('https://evil.example/enc.key', upstream)).toThrow(
      /this camera streams from/,
    );
  });

  it('refuses a scheme that is not http(s)', () => {
    expect(() => assertRelayable('file:///etc/passwd', upstream)).toThrow(/http\(s\) only/);
  });

  it('refuses the metadata endpoint even when the port differs only', () => {
    expect(() => assertRelayable('http://169.254.169.254/latest/meta-data/', upstream)).toThrow(
      RelayUpstreamError,
    );
  });
});

describe('rewritePlaylist', () => {
  const upstream = 'https://cctv.example.gov/cam01/index.m3u8';

  it('rewrites segment lines to relative relay URLs', () => {
    const { body } = rewritePlaylist(SANDBOX_PLAYLIST, upstream);
    const seg = body.split('\n').find((l) => l.startsWith('media?u='));
    expect(seg).toBeDefined();
    expect(decodeUpstreamToken(seg!.slice('media?u='.length))).toBe(
      'https://cctv.example.gov/cam01/seg00000.ts',
    );
  });

  it('rewrites the AES-128 key URI, which is absolute at the gateway root', () => {
    const { body } = rewritePlaylist(SANDBOX_PLAYLIST, upstream);
    const key = body.split('\n').find((l) => l.startsWith('#EXT-X-KEY'));
    const uri = /URI="([^"]+)"/.exec(key ?? '')?.[1] ?? '';
    expect(uri.startsWith('media?u=')).toBe(true);
    expect(decodeUpstreamToken(uri.slice('media?u='.length))).toBe(
      'https://cctv.example.gov/enc.key',
    );
    // The rest of the attribute list survives untouched.
    expect(key).toContain('METHOD=AES-128');
    expect(key).toContain('IV=0x00000000000000000000000000000000');
  });

  it('leaves every other tag alone', () => {
    const { body } = rewritePlaylist(SANDBOX_PLAYLIST, upstream);
    expect(body).toContain('#EXT-X-TARGETDURATION:8');
    expect(body).toContain('#EXTINF:7.920000,');
    expect(body).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
  });

  it('reports VOD, and lists the segments in playlist order', () => {
    const { vod, segments } = rewritePlaylist(SANDBOX_PLAYLIST, upstream);
    expect(vod).toBe(true);
    expect(segments).toEqual([
      'https://cctv.example.gov/cam01/seg00000.ts',
      'https://cctv.example.gov/cam01/seg00001.ts',
    ]);
  });

  it('reports a live playlist as not VOD', () => {
    const live = '#EXTM3U\n#EXTINF:6,\nseg1.ts\n';
    expect(rewritePlaylist(live, upstream).vod).toBe(false);
  });

  it('rewrites a master playlist’s variant URIs through the same path', () => {
    const master =
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=283424,RESOLUTION=640x360\nvideo1_stream.m3u8\n';
    const { body } = rewritePlaylist(master, 'https://gw.example/live/index.m3u8');
    const variant = body.split('\n').find((l) => l.startsWith('media?u='));
    expect(decodeUpstreamToken(variant!.slice('media?u='.length))).toBe(
      'https://gw.example/live/video1_stream.m3u8',
    );
  });

  it('honours the mount path it is told to emit, so the relay is mountable twice', () => {
    const { body } = rewritePlaylist(SANDBOX_PLAYLIST, upstream, 'chunk');
    expect(body).toContain('chunk?u=');
    expect(body).not.toContain('media?u=');
  });

  it('leaves METHOD=NONE alone — there is no URI to rewrite', () => {
    const none = '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6,\na.ts\n';
    expect(rewritePlaylist(none, upstream).body).toContain('#EXT-X-KEY:METHOD=NONE');
  });
});

describe('contentTypeFor', () => {
  it('corrects the sandbox’s mislabelled MPEG-TS segments', () => {
    expect(
      contentTypeFor(
        new URL('https://gw.example/cam01/seg00000.ts'),
        'text/vnd.trolltech.linguist; charset=utf-8',
      ),
    ).toBe('video/mp2t');
  });

  it('keeps a sane declared type when the extension says nothing', () => {
    expect(contentTypeFor(new URL('https://gw.example/thing'), 'video/mp4')).toBe('video/mp4');
  });
});

describe('StreamRelay', () => {
  const relayWith = (fetchImpl: typeof fetch, over = {}) =>
    new StreamRelay({
      host: 'cctv.example.gov',
      cookie: 'sentinel=secret',
      fetchImpl,
      readAhead: 0,
      ...over,
    });

  const ok = (body: string | Buffer, contentType = 'application/vnd.apple.mpegurl') =>
    new Response(body, { status: 200, headers: { 'content-type': contentType } });

  it('fetches a playlist once and serves every later request from cache', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(ok(SANDBOX_PLAYLIST))) as unknown as typeof fetch;
    const relay = relayWith(fetchImpl);

    const first = await relay.playlist(camera());
    const second = await relay.playlist(camera());

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.bytes.toString('utf8')).toBe(first.bytes.toString('utf8'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(relay.stats().hits).toBe(1);
  });

  it('sends the session cookie and a browser user-agent upstream, and neither comes back', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      seen.push(init);
      return Promise.resolve(ok(SANDBOX_PLAYLIST));
    }) as unknown as typeof fetch;

    const relay = relayWith(fetchImpl);
    const result = await relay.playlist(camera());

    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers['cookie']).toBe('sentinel=secret');
    expect(headers['user-agent']).toContain('Mozilla/5.0');
    expect(result.bytes.toString('utf8')).not.toContain('sentinel=');
  });

  it('caps concurrent upstream requests so the gateway is paced', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ok(Buffer.alloc(16), 'video/mp2t');
    }) as unknown as typeof fetch;

    const relay = relayWith(fetchImpl, { concurrency: 2 });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        relay.media(new URL(`https://cctv.example.gov/cam01/seg0000${String(i)}.ts`)),
      ),
    );

    expect(peak).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('evicts least-recently-used objects rather than growing without bound', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(ok(Buffer.alloc(400), 'video/mp2t')),
    ) as unknown as typeof fetch;
    const relay = relayWith(fetchImpl, { cacheBytes: 1000 });

    for (let i = 0; i < 5; i += 1) {
      await relay.media(new URL(`https://cctv.example.gov/cam01/seg${String(i)}.ts`));
    }

    expect(relay.stats().cachedBytes).toBeLessThanOrEqual(1000);
    expect(relay.stats().cachedObjects).toBe(2);
  });

  it('reports an upstream failure as 502 — never the gateway’s own 401', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('login', { status: 401 })),
    ) as unknown as typeof fetch;

    await expect(relayWith(fetchImpl).playlist(camera())).rejects.toMatchObject({ status: 502 });
  });

  it('reads ahead of the segment it just served, within the concurrency budget', async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      requested.push(url);
      return Promise.resolve(
        url.endsWith('.m3u8') ? ok(SANDBOX_PLAYLIST) : ok(Buffer.alloc(8), 'video/mp2t'),
      );
    }) as unknown as typeof fetch;

    const relay = relayWith(fetchImpl, { readAhead: 1 });
    await relay.playlist(camera());
    await relay.media(new URL('https://cctv.example.gov/cam01/seg00000.ts'));
    await new Promise((r) => setTimeout(r, 10));

    expect(requested).toContain('https://cctv.example.gov/cam01/seg00001.ts');
    // And the read-ahead result is a cache hit when the player finally asks for it.
    const next = await relay.media(new URL('https://cctv.example.gov/cam01/seg00001.ts'));
    expect(next.cached).toBe(true);
  });

  it('re-serves a cached playlist without re-rewriting it', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(ok(SANDBOX_PLAYLIST))) as unknown as typeof fetch;
    const relay = relayWith(fetchImpl);
    await relay.playlist(camera(), 'media');
    // A different mount path is a different rewrite, so it is a different cache entry.
    const other = await relay.playlist(camera(), 'chunk');
    expect(other.cached).toBe(false);
    expect(other.bytes.toString('utf8')).toContain('chunk?u=');
  });
});
