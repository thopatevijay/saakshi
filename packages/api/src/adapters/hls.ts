import { spawn } from 'node:child_process';
import {
  BROWSER_UA,
  classifyFfmpegError,
  extractFrameArgs,
  measureFpsArgs,
  measuredFpsFrom,
  parseRational,
  probeArgs,
  run,
  streamArgs,
  type HttpAuth,
} from './ffmpeg.js';
import {
  AuthError,
  UnreachableError,
  type AdapterCameraConfig,
  type CameraAdapter,
  type CameraCapabilities,
  type HealthSample,
  type OpenOptions,
  type StreamHandle,
} from './types.js';

/**
 * HLS adapter — **the operational path**.
 *
 * The deployed Sentinel sandbox is HLS-only. The published Integrator's Guide describes RTSP on
 * `:8554` and WHEP on `:8889`; neither exists. What is actually served (established during recon,
 * D0-01) is VOD HLS over HTTPS/443 behind Cloudflare:
 *
 *   - `PLAYLIST-TYPE:VOD` with `ENDLIST` — finite and **seekable**, which is what makes
 *     faster-than-real-time processing possible;
 *   - `#EXT-X-KEY:METHOD=AES-128` with the key at `/enc.key`, which ffmpeg fetches and applies
 *     transparently — but only if the key request also carries auth;
 *   - a `sentinel=` session cookie required on the playlist, the key **and** every segment;
 *   - Cloudflare 403s ffmpeg's default User-Agent, so a browser UA is mandatory.
 *
 * Every one of those is a way to get an empty stream and blame the camera.
 */

/** How long a window `probe()` decodes to count frames. Long enough to span a 6 s GOP twice. */
const FPS_WINDOW_S = 4;

/** Bytes of playlist read before giving up on finding the header tags. */
const PLAYLIST_PREFIX_BYTES = 4_096;

export interface HlsAdapterOptions {
  /** Session cookie. Read from config, never hardcoded, never logged. */
  cookie?: string | undefined;
  userAgent?: string | undefined;
  ffmpegBin?: string;
  ffprobeBin?: string;
  probeTimeoutMs?: number;
}

interface FfprobeStream {
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

/**
 * HLS adds one method beyond the shared interface: `extractFrame`. It is deliberately *not* on
 * `CameraAdapter` — a seek-to-JPEG is meaningless for a live transport, and widening the interface
 * to accommodate one implementation is how an abstraction rots. Callers that need it construct the
 * HLS adapter directly and get the wider type.
 */
export interface HlsAdapter extends CameraAdapter {
  extractFrame(cfg: AdapterCameraConfig, seekS: number, outPath: string): Promise<void>;
}

export function createHlsAdapter(options: HlsAdapterOptions = {}): HlsAdapter {
  const ffmpeg = options.ffmpegBin ?? 'ffmpeg';
  const ffprobe = options.ffprobeBin ?? 'ffprobe';
  // A 12-hour VOD playlist is 14,408 lines / 7,200 segments and ffmpeg parses all of it before the
  // first frame. Measured 27 s on an idle gateway and 295 s under load, so the deadline is set for
  // the bad afternoon, not the good one.
  const timeout = options.probeTimeoutMs ?? 420_000;
  const auth: HttpAuth = { cookie: options.cookie, userAgent: options.userAgent ?? BROWSER_UA };

  /**
   * `GET /api/ingest` is the contract; the URL pattern is not. The endpoint therefore comes from
   * the registry row, and this adapter never constructs one from a template.
   */
  const urlFor = (cfg: AdapterCameraConfig): string => {
    const url = cfg.endpoints['hls'] ?? cfg.endpoints['url'];
    if (url === undefined || url === '') {
      throw new UnreachableError(
        `camera ${cfg.externalId} has no 'hls' endpoint in its registry row`,
        cfg.externalId,
        'hls',
      );
    }
    return url;
  };

  /**
   * Reads only the **head** of the playlist, to answer what ffprobe does not expose: is it VOD, and
   * are the segments encrypted.
   *
   * Reading a prefix rather than the whole file is not a micro-optimisation. A 12-hour playlist is
   * 14,408 lines / 7,200 segments, and a probe was downloading all of it **three times** — once
   * here, once for ffprobe, once for the fps measurement. When the gateway degraded (a playlist
   * fetch that took seconds in the morning was still incomplete after 120 s), that tripled cost was
   * the difference between probing and timing out. D1-05 re-probes every camera on a schedule, so
   * this compounds across the estate.
   *
   * Correct by the HLS spec, not just cheap: `#EXT-X-PLAYLIST-TYPE:VOD` appears in the header and
   * *means* the playlist is complete and immutable — which is exactly the property a seek needs.
   * `#EXT-X-KEY` is likewise a header tag. `#EXT-X-ENDLIST` lives at the end of the file and is only
   * consulted as a fallback, for a playlist that omits `PLAYLIST-TYPE`.
   */
  const inspectPlaylist = async (
    url: string,
  ): Promise<{ seekable: boolean; encrypted: boolean; ok: boolean; status: number }> => {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': auth.userAgent ?? BROWSER_UA,
          ...(auth.cookie !== undefined && auth.cookie !== '' ? { cookie: auth.cookie } : {}),
        },
        redirect: 'manual',
      });

      if (!response.ok || response.body === null) {
        return { ok: response.ok, status: response.status, seekable: false, encrypted: false };
      }

      // Read the prefix, then abandon the rest of the transfer.
      // Typed explicitly: undici's ReadableStream is `any`-typed in this TS/lib combination, and
      // an implicit `any` here would silently defeat the strict settings everywhere else.
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let head = '';
      try {
        while (head.length < PLAYLIST_PREFIX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          head += decoder.decode(value, { stream: true });
          if (head.includes('#EXT-X-ENDLIST')) break;
        }
      } finally {
        await reader.cancel();
      }

      return {
        ok: true,
        status: response.status,
        seekable: head.includes('#EXT-X-PLAYLIST-TYPE:VOD') || head.includes('#EXT-X-ENDLIST'),
        encrypted: head.includes('#EXT-X-KEY'),
      };
    } catch {
      return { ok: false, status: 0, seekable: false, encrypted: false };
    }
  };

  async function probe(cfg: AdapterCameraConfig): Promise<CameraCapabilities> {
    const url = urlFor(cfg);
    const startedAt = Date.now();

    const playlist = await inspectPlaylist(url);
    // A 30x to the login page is the sandbox's answer to a missing cookie. Classifying it here
    // rather than letting ffmpeg fail on HTML-as-playlist gives a far better error.
    if (
      !playlist.ok &&
      (playlist.status === 401 || playlist.status === 403 || playlist.status >= 300)
    ) {
      throw new AuthError(
        `playlist for ${cfg.externalId} returned HTTP ${String(playlist.status)} — the session ` +
          `token is missing or expired; the camera itself may be fine`,
        cfg.externalId,
        'hls',
      );
    }

    const probed = await run(ffprobe, probeArgs(url, auth), timeout);
    if (probed.code !== 0) {
      throw classifyFfmpegError(probed.stderr, cfg.externalId, 'hls', probed);
    }

    const parsed = JSON.parse(probed.stdout) as {
      streams?: FfprobeStream[];
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];

    // The header's own numbers, kept only so the delta can be reported. On cam01 ffprobe returns
    // r_frame_rate 25/1 *and* avg_frame_rate 30/1 for the same stream — it contradicts itself,
    // which is the whole argument for measuring.
    const declaredFps =
      parseRational(stream?.avg_frame_rate) ?? parseRational(stream?.r_frame_rate);

    const measured = await run(
      ffmpeg,
      measureFpsArgs(url, auth, { windowS: FPS_WINDOW_S }),
      timeout,
    );
    const measuredFps = measuredFpsFrom(measured.stderr, FPS_WINDOW_S);

    const duration = parsed.format?.duration;

    return {
      transport: 'hls',
      reachable: true,
      decodable: stream !== undefined,
      codec: stream?.codec_name ?? null,
      width: stream?.width ?? null,
      height: stream?.height ?? null,
      measuredFps,
      declaredFps,
      durationS: duration === undefined ? null : Number(Number(duration).toFixed(1)),
      seekable: playlist.seekable,
      encrypted: playlist.encrypted,
      probeMs: Date.now() - startedAt,
      probedAt: new Date().toISOString(),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async function open(cfg: AdapterCameraConfig, opts: OpenOptions = {}): Promise<StreamHandle> {
    const url = urlFor(cfg);
    const args = streamArgs(url, auth, {
      seekS: opts.seekS,
      durationS: opts.durationS,
      format: opts.format ?? 'rawvideo',
      fps: opts.fps,
    });

    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      // Join-time decoder warnings are normal on a mid-GOP seek and are never fatal — the recon
      // notes are explicit about that. Kept for classification if the process then fails.
      stderr = (stderr + d.toString()).slice(-8_192);
    });

    const closed = new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    });

    return {
      cameraId: cfg.externalId,
      transport: 'hls',
      url,
      startOffsetS: opts.seekS ?? 0,
      stdout: child.stdout,
      closed,
      close: async () => {
        child.kill('SIGTERM');
        await closed;
      },
    };
  }

  async function close(handle: StreamHandle): Promise<void> {
    await handle.close();
  }

  async function health(cfg: AdapterCameraConfig): Promise<HealthSample> {
    const startedAt = Date.now();
    try {
      const caps = await probe(cfg);
      return {
        transport: 'hls',
        connectable: caps.reachable,
        decodable: caps.decodable,
        measuredFps: caps.measuredFps,
        actualResolution:
          caps.width === null || caps.height === null
            ? null
            : `${String(caps.width)}x${String(caps.height)}`,
        actualCodec: caps.codec,
        latencyMs: Date.now() - startedAt,
        error: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      // health() reports rather than throws: the prober's job is to record that a camera is
      // unhealthy, and an exception here would abort a sweep over thousands of cameras.
      return {
        transport: 'hls',
        connectable: !(error instanceof UnreachableError),
        decodable: false,
        measuredFps: null,
        actualResolution: null,
        actualCodec: null,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /** Extracts one JPEG at an offset. Used by the probe CLI to prove a seek landed. */
  async function extractFrame(
    cfg: AdapterCameraConfig,
    seekS: number,
    outPath: string,
  ): Promise<void> {
    const url = urlFor(cfg);
    const result = await run(ffmpeg, extractFrameArgs(url, auth, { seekS, outPath }), timeout);
    if (result.code !== 0) throw classifyFfmpegError(result.stderr, cfg.externalId, 'hls', result);
  }

  const adapter: HlsAdapter = {
    kind: 'hls',
    description: 'HLS over HTTPS — VOD or live, AES-128 aware, cookie and browser-UA injection',
    status: 'operational',
    probe,
    open,
    close,
    health,
    extractFrame,
  };

  return adapter;
}
