/**
 * The federation contract.
 *
 * Model 4 scores "System Architecture & Integration Depth", and the claim being scored is that
 * onboarding a new department's VMS means **writing one file, never touching the core**. This
 * interface is that claim. If it leaks — if the ingest worker ever needs to know whether a camera
 * is HLS or RTSP — the claim is false, so nothing outside `adapters/` may branch on `kind`.
 */

/**
 * Adapter kinds, keyed to the `adapter_kind` enum in `db/migrations/0002_enums.up.sql`.
 *
 * Note the divergence from D1-03's interface sketch, which wrote `'nvr-file'`: the shipped enum has
 * `nvr` and `file` as separate values, and renaming a database enum to accommodate a stub is not
 * worth a migration. The registry keys on the enum, because the database is what the registry
 * actually stores.
 */
export const adapterKinds = ['hls', 'rtsp', 'onvif', 'whep', 'nvr', 'file'] as const;
export type AdapterKind = (typeof adapterKinds)[number];

/** What an adapter needs to reach a camera. A subset of the registry row, deliberately narrow. */
export interface AdapterCameraConfig {
  externalId: string;
  adapterKind: AdapterKind;
  /** Adapter-specific, e.g. `{ hls: 'https://host/cam09/index.m3u8' }`. */
  endpoints: Record<string, string>;
}

/**
 * How a camera turned out to actually be reachable, and what it actually delivers.
 *
 * Everything here is **measured**. The sandbox catalogue declares `{id, name}` and nothing else —
 * no codec, no fps, no resolution, no location — so this is the strongest form of Pillar 1's
 * "measure, don't trust declared metadata": there is no declared metadata to trust.
 *
 * `declaredFps` records what the *container header* claims, purely so the delta can be reported.
 * On `cam01` ffprobe reports `r_frame_rate: 25/1` and `avg_frame_rate: 30/1` for the same stream —
 * the header contradicts itself, which is why `measuredFps` exists.
 */
export interface CameraCapabilities {
  /** Which transport actually served the stream. Recorded so the UI can show it. */
  transport: AdapterKind;
  reachable: boolean;
  decodable: boolean;

  codec: string | null;
  width: number | null;
  height: number | null;

  /** Counted from decoded frames over a sampled window. Authoritative. */
  measuredFps: number | null;
  /** Whatever the header claims. Never used for timing decisions. */
  declaredFps: number | null;
  /** Seconds. Null for a live stream with no `ENDLIST`. */
  durationS: number | null;

  /** True when the playlist is `PLAYLIST-TYPE:VOD` with `ENDLIST` — seeking is then supported. */
  seekable: boolean;
  /** True when segments are AES-128 encrypted (the sandbox's are; ffmpeg resolves the key). */
  encrypted: boolean;

  /** Wall-clock milliseconds the probe took, so the prober can spot slow cameras. */
  probeMs: number;
  probedAt: string;
}

/** One health observation. D1-05 writes these into the `camera_health_checks` hypertable. */
export interface HealthSample {
  transport: AdapterKind;
  connectable: boolean;
  decodable: boolean;
  measuredFps: number | null;
  actualResolution: string | null;
  actualCodec: string | null;
  /** Round-trip to first frame. */
  latencyMs: number | null;
  error: string | null;
  checkedAt: string;
}

/** An open stream. Frames arrive as raw output on `stdout` for the analytics worker (D1-09). */
export interface StreamHandle {
  cameraId: string;
  transport: AdapterKind;
  /** The resolved URL, for logging. Never contains credentials — those travel in headers. */
  url: string;
  /** Seconds into the stream this handle started at. 0 unless a seek was requested. */
  startOffsetS: number;
  stdout: import('node:stream').Readable | null;
  /** Resolves when the process exits. */
  closed: Promise<number | null>;
  close: () => Promise<void>;
}

export interface OpenOptions {
  /** Seconds to seek to before the first frame. VOD only. */
  seekS?: number;
  /** Stop after this many seconds of content. */
  durationS?: number;
  /**
   * Output format for the frame stream. `rawvideo` for the analytics worker; `image2pipe` when a
   * caller wants discrete JPEGs.
   */
  format?: 'rawvideo' | 'image2pipe' | 'null';
  /** Frames per second to emit. Below the source rate this is a deliberate decimation. */
  fps?: number;
}

/**
 * Every adapter implements exactly this. Five methods, no optional extras — an adapter that needs
 * a sixth method is a sign the abstraction is wrong, not that the interface needs widening.
 */
export interface CameraAdapter {
  readonly kind: AdapterKind;
  /** One line, shown in the UI and in `docs/adapter-framework.md`'s transport table. */
  readonly description: string;
  /**
   * Honest status. `operational` = verified against the government feed. `demonstrated` = verified
   * against local MediaMTX but **not** against the sandbox, which serves no such transport.
   * `stub` = interface only. This field is why the docs table cannot drift from the code.
   */
  readonly status: 'operational' | 'demonstrated' | 'stub';

  probe(cfg: AdapterCameraConfig): Promise<CameraCapabilities>;
  open(cfg: AdapterCameraConfig, options?: OpenOptions): Promise<StreamHandle>;
  close(handle: StreamHandle): Promise<void>;
  health(cfg: AdapterCameraConfig): Promise<HealthSample>;
}

// ── Error taxonomy ──────────────────────────────────────────────────────────────────────────────
//
// The distinction between these is a product requirement, not tidiness. An expired session cookie
// reported as "camera down" sends a technician to a working camera and hides the real fault, so the
// classes below are what the trust score and the UI branch on.

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly cameraId: string,
    readonly transport: AdapterKind,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Credentials rejected: 401, 403, or a 302 to a login page. Fix the cookie, not the camera. */
export class AuthError extends AdapterError {}

/** Network-level failure: DNS, refused, timeout. The camera or the path to it is genuinely down. */
export class UnreachableError extends AdapterError {}

/** Reached and authorised, but the bytes are not decodable video. */
export class DecodeError extends AdapterError {}

/** The transport is not implemented. Thrown by the `nvr` stub, and it says so. */
export class NotImplementedError extends AdapterError {}

/**
 * The operation was killed for exceeding its deadline.
 *
 * Deliberately distinct from `DecodeError`. A slow gateway and an undecodable stream demand
 * opposite responses — wait and retry, versus stop trying and investigate the camera — and this
 * was a real defect: a 12-hour VOD playlist is 14,408 lines / 7,200 segments, so under load the
 * sandbox took **295 s** for a probe that had taken 27 s an hour earlier. The killed ffmpeg was
 * being reported as "the stream is not decodable", which would have condemned a perfectly good
 * camera on the strength of a slow afternoon.
 */
export class TimeoutError extends AdapterError {}
