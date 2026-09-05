/**
 * Response contracts for the video wall (D3-07).
 *
 * Kept beside the routes rather than in `@saakshi/shared` because nothing outside the API and the
 * generated web client reads them — and `packages/shared/src/index.ts` is a file three branches
 * are editing this week.
 */
import { z } from 'zod';
import { TrustBand } from './camera-contracts.js';

/** Grid shapes the wall offers. The count is derived, never written twice. */
export const WALL_GRIDS = ['2x2', '3x3', '4x4'] as const;
export const WallGrid = z.enum(WALL_GRIDS);
export type WallGrid = z.infer<typeof WallGrid>;

export const WALL_MODES = ['hls', 'whep'] as const;
export const WallMode = z.enum(WALL_MODES);

/**
 * A saved wall.
 *
 * `slots` is positional and sparse-by-`null`: slot 4 being empty is a thing an operator chose, and
 * compacting it on save would silently rearrange their wall.
 */
export const WallLayout = z.object({
  grid: WallGrid,
  slots: z.array(z.uuid().nullable()).max(16),
  overlay: z.boolean().default(true),
  mode: WallMode.default('hls'),
});
export type WallLayout = z.infer<typeof WallLayout>;

/**
 * Why a camera looks the way it does on a tile.
 *
 * Every field here is **read from the latest health check**, never recomputed. D1-06/D1-08 are
 * explicit: `band` is resolved server-side from the latest check's `connectable`, and a client that
 * applies its own threshold paints a camera that went dark yesterday green.
 */
export const StreamTrust = z.object({
  band: TrustBand.nullable(),
  score: z.number().nullable(),
  checkedAt: z.string().nullable(),
  connectable: z.boolean().nullable(),
  decodable: z.boolean().nullable(),
  /** The prober's own error string. This is the sentence a dead tile shows instead of a spinner. */
  error: z.string().nullable(),
  measuredFps: z.number().nullable(),
  actualResolution: z.string().nullable(),
  actualCodec: z.string().nullable(),
  /** Signals that cost this camera points, worst first. Empty for a trusted or unprobed camera. */
  failingSignals: z.array(
    z.object({
      signal: z.string(),
      note: z.string(),
      points: z.number(),
      maxPoints: z.number(),
    }),
  ),
});

export const StreamManifest = z.object({
  cameraId: z.uuid(),
  externalId: z.string(),
  name: z.string(),
  departmentCode: z.string().nullable(),
  district: z.string().nullable(),
  catalogueStatus: z.string(),
  status: z.string(),
  trust: StreamTrust,

  /**
   * The source frame size the analytics ran at, so a detection box can be projected onto the tile.
   *
   * Measured first (`camera_health_checks.actual_resolution`), declared second, and null when
   * neither exists. The browser's `video.videoWidth/videoHeight` is the authority once metadata
   * has loaded; this is what lets the tile *notice* when the two disagree instead of drawing boxes
   * in the wrong place and looking convincing.
   */
  source: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      origin: z.enum(['measured', 'declared']),
    })
    .nullable(),

  /** Relative to the mount the caller reached this manifest through. Null when unresolvable. */
  hls: z.object({ playlist: z.string() }).nullable(),
  /** Null when our edge gateway publishes no path for this camera — which is the sandbox norm. */
  whep: z.object({ url: z.string(), path: z.string() }).nullable(),
  /** Why there is no WHEP, in a sentence a judge can read. Null when there is. */
  whepUnavailable: z.string().nullable(),

  /** Detections already recorded against this camera, and the newest PTS among them. */
  sightings: z.object({
    total: z.number().int(),
    latestPtsMs: z.number().nullable(),
    latestTs: z.string().nullable(),
  }),
});
export type StreamManifest = z.infer<typeof StreamManifest>;

/** One detection, in the source frame's own pixel space. Projection happens in the browser. */
export const StreamDetection = z.object({
  id: z.uuid(),
  ptsMs: z.number(),
  ts: z.string(),
  trackId: z.number().int(),
  class: z.string(),
  bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  confidence: z.number(),
  vehicleColor: z.string().nullable(),
  plate: z.string().nullable(),
  plateConfidence: z.number().nullable(),
});

export const StreamDetectionsResponse = z.object({
  cameraId: z.uuid(),
  fromPtsMs: z.number(),
  toPtsMs: z.number(),
  detections: z.array(StreamDetection),
});

/** What the relay is doing to the gateway right now. The tile's honest answer to "why so slow". */
export const RelayStatsResponse = z.object({
  cachedObjects: z.number().int(),
  cachedBytes: z.number().int(),
  hits: z.number().int(),
  misses: z.number().int(),
  upstreamRequests: z.number().int(),
  inFlight: z.number().int(),
  queued: z.number().int(),
  meanUpstreamMs: z.number().int(),
});
