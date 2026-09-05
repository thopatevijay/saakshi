import { z } from 'zod';
import { BoundingBox, VehicleClass } from './sighting.js';

/**
 * One best-shot crop on its way from the analytics worker to the object store.
 *
 * Its own stream and its own type rather than more fields on `Sighting`, for a reason that is about
 * rates and not about tidiness: `sightings` carries roughly one entry per detection per inferred
 * frame, and `evidence` carries one per *track session*, each about 20 KB. One bounded stream
 * cannot be trimmed correctly for both.
 *
 * The record identifies its sighting by `(cameraId, trackId, framePtsMs)`. That is unique **because
 * `trackId` is session-qualified** (`session * 100_000 + tracker_id`, D1-09): the raw ByteTrack id
 * is reused across a loop-point scene cut, and joining on it would attach one vehicle's crop to a
 * different vehicle's row.
 */
export const EvidenceRecord = z.object({
  /** The camera's EXTERNAL id (`cam01`), exactly as the `sightings` stream carries it. */
  cameraId: z.string().min(1),
  trackId: z.number().int().nonnegative(),
  /** PTS-derived wall clock of the source frame. Never the time the crop was produced. */
  ts: z.iso.datetime(),
  framePtsMs: z.number().nonnegative(),

  kind: z.enum(['vehicle', 'plate']).default('vehicle'),
  class: VehicleClass,
  detConfidence: z.number().min(0).max(1),
  bbox: BoundingBox,

  /** 0-1. How good this observation was as evidence, versus the rest of its track session. */
  bestShotScore: z.number().min(0).max(1),
  /** Variance of the Laplacian of the crop. Comparable within a camera, not across cameras. */
  focus: z.number().nonnegative(),
  /** Observations of this track that were considered before this one won. The compression ratio. */
  observations: z.number().int().positive().default(1),

  vehicleType: z.string().nullable().default(null),
  /** `unknown` when the classifier refused the read — never the runner-up quietly promoted. */
  vehicleColor: z.string(),
  vehicleColorConfidence: z.number().min(0).max(1),
  attributesLowConfidence: z.boolean(),
  /** Share of the voting region that carried any colour at all. ~0 on a night frame. */
  colorChromaShare: z.number().min(0).max(1).default(0),
  colorRunnerUp: z.string().nullable().default(null),

  /**
   * Vehicle appearance descriptor (D3-03), or `null` when none could be made.
   *
   * **Not biometric.** It describes the outside of a vehicle — white-balanced colour histograms over
   * four stripes of the crop plus a coarse edge signature. SAAKSHI performs no face recognition and
   * stores no biometric template; `docs/reid.md` §2 and migration `0022` both say so, because a
   * reader who sees "embedding" and assumes "face" would be wrong about the most sensitive thing in
   * the system.
   *
   * Optional and nullable so that a record produced before D3-03 — or by a worker whose embedder
   * failed — still validates. The consumer writes `sighting_appearance` only when both fields are
   * present, and two descriptors may only ever be compared when their `appearanceEmbedderId`s match.
   */
  appearanceEmbedderId: z.string().min(1).nullable().default(null),
  appearance: z.array(z.number()).min(1).max(4096).nullable().default(null),

  contentType: z.string().default('image/jpeg'),
  /** The JPEG. Base64 because both Valkey clients round-trip text safely and neither does bytes. */
  cropBase64: z.string().min(1),
  cropBytes: z.number().int().nonnegative(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;
