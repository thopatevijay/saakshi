import { spawn } from 'node:child_process';
import {
  AuthError,
  DecodeError,
  TimeoutError,
  UnreachableError,
  type AdapterKind,
} from './types.js';

/**
 * ffmpeg/ffprobe plumbing shared by the transport adapters.
 *
 * The argv builders are **pure functions returning string[]**, deliberately. D1-03 requires the
 * auth header and browser User-Agent to be "asserted on the actual ffmpeg argv, not assumed", and
 * that is only testable if building the argv is separable from running it.
 */

/**
 * Cloudflare fronts the sandbox and **403s ffmpeg's default User-Agent**
 * (`Lavf/<version>`). Established during recon — not a precaution, a requirement. Without this
 * every request fails before the playlist is even parsed.
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export interface HttpAuth {
  /** Raw cookie header value, e.g. `sentinel=…`. Never logged. */
  cookie?: string | undefined;
  userAgent?: string | undefined;
}

/** True for `http://` and `https://` inputs. */
export const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * HTTP options for ffmpeg's demuxer.
 *
 * `-headers` and `-user_agent` are **input options**: ffmpeg applies them to every HTTP request the
 * demuxer makes for that input — the playlist, the AES-128 key at `/enc.key`, and every segment.
 * That matters because the sandbox 302s all three to a login page without the cookie, so applying
 * auth only to the playlist would fail at the first key fetch.
 *
 * The trailing CRLF on `-headers` is required: ffmpeg passes the string through verbatim, and
 * without a line terminator it corrupts the request when other headers follow.
 *
 * **These options belong to the HTTP demuxer only.** Passing `-reconnect` to an RTSP input makes
 * ffmpeg exit immediately with `Option reconnect not found` — a real bug the MediaMTX suite caught,
 * where the RTSP adapter opened a stream that produced no frames at all. Hence `forUrl`: callers
 * that may be handed a non-HTTP URL pass it, and the HTTP-specific flags are then omitted.
 */
export function httpInputArgs(auth: HttpAuth, forUrl?: string): string[] {
  // Only meaningful over HTTP. An RTSP or file input takes neither.
  if (forUrl !== undefined && !isHttpUrl(forUrl)) return [];

  const args: string[] = ['-user_agent', auth.userAgent ?? BROWSER_UA];
  if (auth.cookie !== undefined && auth.cookie !== '') {
    args.push('-headers', `Cookie: ${auth.cookie}\r\n`);
  }
  // Survive the mid-stream disconnects a 12-hour VOD pull over Cloudflare will see. Capped low
  // because the adapter's own backoff (2s -> 30s) is the real retry policy.
  args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  return args;
}

/** ffprobe argv for capability discovery. Reads the header only — no decoding. */
export function probeArgs(url: string, auth: HttpAuth): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    ...httpInputArgs(auth, url),
    '-show_entries',
    'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames',
    '-show_entries',
    'format=duration,format_name',
    '-select_streams',
    'v:0',
    '-of',
    'json',
    url,
  ];
}

/**
 * ffmpeg argv that decodes a window and counts frames.
 *
 * This exists because the header is not trustworthy: on `cam01` ffprobe reports
 * `r_frame_rate: 25/1` **and** `avg_frame_rate: 30/1` for the same stream. Counting decoded frames
 * over a known duration is the only number worth writing to `camera_health_checks.measured_fps`.
 *
 * `-ss` goes **before** `-i`: input seek, so ffmpeg jumps to the segment containing the offset
 * instead of decoding and discarding everything up to it. On a 24-hour VOD playlist that is the
 * difference between a second and an hour.
 */
export function measureFpsArgs(
  url: string,
  auth: HttpAuth,
  opts: { seekS?: number | undefined; windowS: number },
): string[] {
  const args = ['-hide_banner', '-nostdin'];
  if (opts.seekS !== undefined && opts.seekS > 0) args.push('-ss', String(opts.seekS));
  args.push(...httpInputArgs(auth, url), '-i', url, '-t', String(opts.windowS), '-f', 'null', '-');
  return args;
}

/** ffmpeg argv extracting a single JPEG at an offset — the seek proof, and the recon frames. */
export function extractFrameArgs(
  url: string,
  auth: HttpAuth,
  opts: { seekS?: number | undefined; outPath: string },
): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (opts.seekS !== undefined && opts.seekS > 0) args.push('-ss', String(opts.seekS));
  args.push(...httpInputArgs(auth, url), '-i', url, '-frames:v', '1', '-q:v', '2', opts.outPath);
  return args;
}

/** ffmpeg argv for a continuous frame stream — what the analytics worker consumes. */
export function streamArgs(
  url: string,
  auth: HttpAuth,
  opts: {
    seekS?: number | undefined;
    durationS?: number | undefined;
    format: 'rawvideo' | 'image2pipe' | 'null';
    fps?: number | undefined;
    /** RTSP must be forced over TCP; UDP silently drops frames on a congested link. */
    rtspTransportTcp?: boolean;
  },
): string[] {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];
  if (opts.rtspTransportTcp === true) args.push('-rtsp_transport', 'tcp');
  if (opts.seekS !== undefined && opts.seekS > 0) args.push('-ss', String(opts.seekS));
  args.push(...httpInputArgs(auth, url), '-i', url);
  if (opts.durationS !== undefined) args.push('-t', String(opts.durationS));
  if (opts.fps !== undefined) args.push('-vf', `fps=${String(opts.fps)}`);

  if (opts.format === 'null') args.push('-f', 'null', '-');
  else if (opts.format === 'image2pipe')
    args.push('-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1');
  else args.push('-f', 'rawvideo', '-pix_fmt', 'bgr24', 'pipe:1');

  return args;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the deadline elapsed and the child was killed. Never conflate this with a bad stream. */
  timedOut: boolean;
  elapsedMs: number;
}

export function run(bin: string, args: string[], timeoutMs = 300_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      // Bounded: a failing HLS input can emit megabytes of per-segment warnings, and only the tail
      // is ever useful for classification.
      stderr = (stderr + d.toString()).slice(-16_384);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, elapsedMs: Date.now() - startedAt });
    });
  });
}

/**
 * Turns ffmpeg's stderr into the right error class.
 *
 * This function is the whole reason the error taxonomy exists. An expired session cookie and a dead
 * camera produce completely different remedies — refresh the token, or send a technician — and a
 * system that reports both as "camera unreachable" sends the technician. The sandbox makes the
 * distinction easy to get wrong, because an unauthenticated request is answered with a **302 to a
 * login page**, not a 401: ffmpeg follows it and then fails to parse HTML as a playlist.
 */
export function classifyFfmpegError(
  stderr: string,
  cameraId: string,
  transport: AdapterKind,
  result?: { timedOut: boolean; elapsedMs: number },
): Error {
  // Checked before anything in stderr: a killed process leaves whatever partial output it had, and
  // reading that as a verdict on the stream is how a slow link gets recorded as a broken camera.
  if (result?.timedOut === true) {
    return new TimeoutError(
      `camera ${cameraId} over ${transport} exceeded its deadline after ` +
        `${String(Math.round(result.elapsedMs / 1000))}s — the gateway is slow or the playlist is ` +
        `very large; this is not evidence the stream is bad`,
      cameraId,
      transport,
      stderr.slice(-500),
    );
  }

  const s = stderr.toLowerCase();

  const authSignals = [
    'http error 401',
    'http error 403',
    'unauthorized',
    'forbidden',
    'invalid data found when processing input', // the login-page-as-playlist case
    'no such file or directory', // key fetch redirected away
  ];
  const unreachableSignals = [
    'connection refused',
    'connection timed out',
    'failed to resolve hostname',
    'name or service not known',
    'network is unreachable',
    'http error 404',
    'http error 5',
    'i/o error',
    'server returned 4',
    'server returned 5',
    'immediate exit requested',
    'end of file',
  ];

  // Unreachable is checked first: a 404/5xx is unambiguous, whereas the auth list contains
  // 'invalid data found', which a genuinely corrupt stream can also produce.
  if (unreachableSignals.some((sig) => s.includes(sig))) {
    return new UnreachableError(
      `camera ${cameraId} is not reachable over ${transport}`,
      cameraId,
      transport,
      stderr.slice(-500),
    );
  }
  if (authSignals.some((sig) => s.includes(sig))) {
    return new AuthError(
      `credentials rejected for camera ${cameraId} over ${transport} — refresh the session token, ` +
        `the camera itself may be fine`,
      cameraId,
      transport,
      stderr.slice(-500),
    );
  }
  return new DecodeError(
    `camera ${cameraId} responded over ${transport} but the stream is not decodable`,
    cameraId,
    transport,
    stderr.slice(-500),
  );
}

/**
 * Counts frames from ffmpeg's progress output.
 *
 * `-f null -` still decodes; the final `frame=` line in the summary is the decoded frame count.
 * Dividing by the window gives a real measurement rather than a claim.
 */
export function parseFrameCount(stderr: string): number | null {
  const matches = [...stderr.matchAll(/frame=\s*(\d+)/g)];
  const last = matches.at(-1);
  return last?.[1] === undefined ? null : Number(last[1]);
}

/**
 * Seconds of content ffmpeg actually decoded, from its `time=HH:MM:SS.ss` progress output.
 *
 * Needed because dividing the frame count by the *requested* window is wrong whenever the stream
 * is shorter than the window: a 2 s clip sampled over a 3 s window reported 6.67 fps for a genuine
 * 10 fps source. Real cameras hit this too — recon measured sandbox durations from 1.0 h to 24.5 h,
 * and a short or truncated feed would have been silently under-scored on `measured_fps`, which
 * feeds the trust score.
 */
export function parseDecodedSeconds(stderr: string): number | null {
  const matches = [...stderr.matchAll(/time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/g)];
  const last = matches.at(-1);
  if (last === undefined) return null;
  const [, h = '0', m = '0', sec = '0'] = last;
  const total = Number(h) * 3600 + Number(m) * 60 + Number(sec);
  return total > 0 ? total : null;
}

/**
 * Frames per second, measured — frame count over the duration **actually decoded**.
 *
 * Falls back to the requested window only when ffmpeg emitted no timestamp at all, which means it
 * decoded essentially nothing and the answer is null anyway.
 */
export function measuredFpsFrom(stderr: string, requestedWindowS: number): number | null {
  const frames = parseFrameCount(stderr);
  if (frames === null || frames === 0) return null;
  const seconds = parseDecodedSeconds(stderr) ?? requestedWindowS;
  if (seconds <= 0) return null;
  return Number((frames / seconds).toFixed(2));
}

/** `25/1` → 25, `0/0` → null. The header's own claim, kept only to report the delta. */
export function parseRational(value: string | undefined): number | null {
  if (value === undefined) return null;
  const [num, den] = value.split('/').map(Number);
  if (num === undefined || den === undefined || den === 0 || Number.isNaN(num)) return null;
  return Number((num / den).toFixed(3));
}
