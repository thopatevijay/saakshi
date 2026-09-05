import { z } from 'zod';

export const VehicleClass = z.enum([
  'car',
  'motorcycle',
  'bus',
  'truck',
  'auto_rickshaw',
  'bicycle',
  'person',
  'unknown',
]);
export type VehicleClass = z.infer<typeof VehicleClass>;

/** Pixel bounding box in the source frame's own coordinate space. */
export const BoundingBox = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type BoundingBox = z.infer<typeof BoundingBox>;

/** One plate read from one frame. Several reads vote to produce the final text (D2-01). */
export const PlateRead = z.object({
  id: z.uuid().optional(),
  rawText: z.string(),
  /**
   * Canonical `[A-Z0-9]` form (D2-03's `normalise`), after slot-aware correction.
   *
   * **Null means *not evaluated yet*, never *rejected*** (D2-01's handoff on #17): the per-camera
   * rejection rate is a trust signal that only survives if the two stay distinguishable. An
   * ungrammatical read is stored here with `grammarValid: false` and a down-weighted confidence,
   * never dropped.
   */
  normalizedText: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  isBestShot: z.boolean().default(false),
  voteCount: z.number().int().positive().default(1),
  cropUri: z.string().nullable().default(null),
});
export type PlateRead = z.infer<typeof PlateRead>;

/**
 * One tracked object observed on one camera at one instant.
 *
 * `framePtsMs` is the presentation timestamp, **not** arrival time. The sandbox gateway replays a
 * buffered GOP on connect, so an arrival-time clock computes impossible velocities after every
 * reconnect (CLAUDE.md domain rules). `ts` is the wall-clock mapping of that PTS.
 */
export const Sighting = z.object({
  id: z.uuid().optional(),
  cameraId: z.string().min(1),
  ts: z.iso.datetime(),
  framePtsMs: z.number().nonnegative(),
  /** Tracker-local id. Resets on scene cut — feeds loop, and IDs must not bleed across the cut. */
  trackId: z.number().int().nonnegative(),

  class: VehicleClass,
  bbox: BoundingBox,
  detConfidence: z.number().min(0).max(1),

  vehicleColor: z.string().nullable().default(null),
  vehicleType: z.string().nullable().default(null),
  cropUri: z.string().nullable().default(null),

  plateReads: z.array(PlateRead).default([]),
  ingestedAt: z.iso.datetime().optional(),
});
export type Sighting = z.infer<typeof Sighting>;
