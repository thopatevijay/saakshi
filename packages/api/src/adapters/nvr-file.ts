import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import {
  classifyFfmpegError,
  measuredFpsFrom,
  parseRational,
  run,
  streamArgs,
} from './ffmpeg.js';
import {
  NotImplementedError,
  UnreachableError,
  type AdapterCameraConfig,
  type CameraAdapter,
  type CameraCapabilities,
  type HealthSample,
  type OpenOptions,
  type StreamHandle,
} from './types.js';

/**
 * Two adapters live in this file, because they are two halves of the same idea: video that is not
 * a live stream.
 *
 * ── `file` — implemented ────────────────────────────────────────────────────────────────────────
 * A recorded clip on disk. Not a toy: it is how the own-feed demonstration (D3-11) runs, how the
 * ANPR evaluation set (D2-01) is scored reproducibly, and how any of this is testable without the
 * sandbox. A file is also the most honest ANPR benchmark there is — the same clip, every run.
 *
 * ── `nvr` — an honest stub ──────────────────────────────────────────────────────────────────────
 * Pulling recorded footage out of a vendor NVR (Hikvision ISAPI, Dahua, Milestone XProtect) needs a
 * per-vendor SDK and, more to the point, a device to test against. **We have neither.** So the
 * interface is implemented and every method throws `NotImplementedError` with a message that says
 * exactly that.
 *
 * This is deliberate, and it is the point of shipping it: it demonstrates that the framework
 * accommodates a transport nobody has built yet, and it keeps the claim honest. A stub that
 * silently returned empty capabilities would look like support and be worse than nothing —
 * a department would onboard cameras that quietly never produce a frame.
 */

const FPS_WINDOW_S = 3;

export function createFileAdapter(options: { ffmpegBin?: string; ffprobeBin?: string } = {}): CameraAdapter {
  const ffmpeg = options.ffmpegBin ?? 'ffmpeg';
  const ffprobe = options.ffprobeBin ?? 'ffprobe';

  const pathFor = (cfg: AdapterCameraConfig): string => {
    const path = cfg.endpoints['file'] ?? cfg.endpoints['path'] ?? cfg.endpoints['url'];
    if (path === undefined || path === '') {
      throw new UnreachableError(
        `camera ${cfg.externalId} has no 'file' endpoint in its registry row`,
        cfg.externalId,
        'file',
      );
    }
    return path;
  };

  async function probe(cfg: AdapterCameraConfig): Promise<CameraCapabilities> {
    const path = pathFor(cfg);
    const startedAt = Date.now();

    try {
      await access(path);
    } catch {
      throw new UnreachableError(`file not found: ${path}`, cfg.externalId, 'file');
    }

    const probed = await run(ffprobe, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-show_entries',
      'stream=codec_name,width,height,r_frame_rate,avg_frame_rate',
      '-show_entries',
      'format=duration',
      '-select_streams',
      'v:0',
      '-of',
      'json',
      path,
    ]);
    if (probed.code !== 0) throw classifyFfmpegError(probed.stderr, cfg.externalId, 'file', probed);

    const parsed = JSON.parse(probed.stdout) as {
      streams?: { codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }[];
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];

    const measured = await run(ffmpeg, [
      '-hide_banner',
      '-nostdin',
      '-i',
      path,
      '-t',
      String(FPS_WINDOW_S),
      '-f',
      'null',
      '-',
    ]);
    const duration = parsed.format?.duration;

    return {
      transport: 'file',
      reachable: true,
      decodable: stream !== undefined,
      codec: stream?.codec_name ?? null,
      width: stream?.width ?? null,
      height: stream?.height ?? null,
      measuredFps: measuredFpsFrom(measured.stderr, FPS_WINDOW_S),
      declaredFps: parseRational(stream?.avg_frame_rate),
      durationS: duration === undefined ? null : Number(Number(duration).toFixed(1)),
      // A file is the seekable case par excellence — which is what makes it the right substrate
      // for a reproducible ANPR benchmark.
      seekable: true,
      encrypted: false,
      probeMs: Date.now() - startedAt,
      probedAt: new Date().toISOString(),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async function open(cfg: AdapterCameraConfig, opts: OpenOptions = {}): Promise<StreamHandle> {
    const path = pathFor(cfg);
    const child = spawn(
      ffmpeg,
      streamArgs(path, {}, {
        seekS: opts.seekS,
        durationS: opts.durationS,
        format: opts.format ?? 'rawvideo',
        fps: opts.fps,
      }),
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stderr.resume();

    const closed = new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    });

    return {
      cameraId: cfg.externalId,
      transport: 'file',
      url: path,
      startOffsetS: opts.seekS ?? 0,
      stdout: child.stdout,
      closed,
      close: async () => {
        child.kill('SIGTERM');
        await closed;
      },
    };
  }

  async function health(cfg: AdapterCameraConfig): Promise<HealthSample> {
    const startedAt = Date.now();
    try {
      // probe() first: it is what classifies a missing or unreadable file as an UnreachableError.
      // Calling stat() before it leaked a raw ENOENT into `health.error`, which the trust score
      // and the UI cannot branch on.
      const caps = await probe(cfg);
      const info = await stat(pathFor(cfg));
      return {
        transport: 'file',
        connectable: info.size > 0,
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
      return {
        transport: 'file',
        connectable: false,
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

  return {
    kind: 'file',
    description: 'Recorded clip on disk — reproducible benchmarks and the own-feed demonstration',
    status: 'operational',
    probe,
    open,
    close: async (handle) => {
      await handle.close();
    },
    health,
  };
}

/** The stub. Every method throws, and the message names the vendor SDK that would be needed. */
export function createNvrAdapter(): CameraAdapter {
  const notImplemented = (cameraId: string): NotImplementedError =>
    new NotImplementedError(
      'the NVR adapter is a documented stub: pulling recorded footage from a vendor NVR ' +
        '(Hikvision ISAPI, Dahua, Milestone XProtect) requires a per-vendor SDK and a device to ' +
        'test against, and we have neither. The interface is implemented to show the framework ' +
        'accommodates it; nothing about NVR retrieval is claimed to work.',
      cameraId,
      'nvr',
    );

  return {
    kind: 'nvr',
    description: 'Vendor NVR recorded-footage retrieval — STUB, interface only, nothing claimed',
    status: 'stub',
    probe: (cfg) => Promise.reject(notImplemented(cfg.externalId)),
    open: (cfg) => Promise.reject(notImplemented(cfg.externalId)),
    close: () => Promise.resolve(),
    // health() resolves rather than rejects, and reports the stub honestly — a prober sweeping
    // thousands of cameras must not crash on one, and "not implemented" is a real health answer.
    health: (cfg) =>
      Promise.resolve({
        transport: 'nvr' as const,
        connectable: false,
        decodable: false,
        measuredFps: null,
        actualResolution: null,
        actualCodec: null,
        latencyMs: null,
        error: `NotImplementedError: ${notImplemented(cfg.externalId).message}`,
        checkedAt: new Date().toISOString(),
      }),
  };
}
