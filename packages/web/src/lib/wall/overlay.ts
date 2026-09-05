/**
 * Projecting a detection box onto a tile.
 *
 * ## Why this is a real problem and not arithmetic
 *
 * A bounding box is stored in **the source frame's own pixel space** — `BoundingBox` in
 * `packages/shared/src/sighting.ts` says so, and `workers/analytics/pipeline.py` writes
 * `{x, y, w, h}` straight out of the tracker. Nothing anywhere records *what size that frame was*.
 * The estate is not homogeneous either: D1-05 measured **six distinct resolutions** across thirty
 * cameras — 854×480 (12) · 1920×1080 (11) · 1280×960 (3) · 1280×720 (2) · 640×480 (1) · 960×576 (1)
 * — so a transform tuned on one camera is wrong on nineteen others, and it is wrong *plausibly*:
 * boxes still appear, still move with traffic, and sit a little off the cars. That is worse than no
 * overlay, because it looks like it works.
 *
 * Two independent scalings are involved and both have to be right:
 *
 *   1. source pixels → a fraction of the frame  (needs the frame size)
 *   2. that fraction → CSS pixels inside the tile  (needs where the frame is *drawn*)
 *
 * Step 2 is the one that gets skipped. A `<video>` with `object-fit: contain` does not fill its
 * element unless the aspect ratios match: a 16:9 stream in a 4:3 tile is letterboxed, a 4:3 stream
 * in a 16:9 tile is pillarboxed, and in both cases the drawn frame is smaller than the element and
 * offset inside it. Multiplying by `element.width` alone puts every box wrong by exactly the size
 * of the bars, which on 640×480 in a 3×3 wall is about 17% of the width.
 *
 * `contain` rather than `cover` is a product decision: `cover` fills the tile and crops the frame,
 * and an operator must never be shown a frame with an edge silently cut off. It also means the
 * overlay geometry below is the whole story.
 */

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Where the decoded frame is actually drawn inside its element, under `object-fit: contain`.
 *
 * Returns the element itself when either size is degenerate, so a tile that has not laid out yet
 * draws nothing rather than dividing by zero.
 */
export function contentRect(source: FrameSize, element: FrameSize): Rect {
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    element.width <= 0 ||
    element.height <= 0 ||
    !Number.isFinite(source.width) ||
    !Number.isFinite(source.height)
  ) {
    return { x: 0, y: 0, w: element.width, h: element.height };
  }

  const scale = Math.min(element.width / source.width, element.height / source.height);
  const w = source.width * scale;
  const h = source.height * scale;
  return { x: (element.width - w) / 2, y: (element.height - h) / 2, w, h };
}

/**
 * A source-pixel box in element coordinates.
 *
 * Clamped to the drawn frame: a tracker box can extend past the edge when a vehicle is leaving, and
 * a rectangle drawn outside the video into the letterbox bar reads as a detection *off* the road.
 */
export function projectBox(bbox: Rect, source: FrameSize, element: FrameSize): Rect {
  const content = contentRect(source, element);
  if (source.width <= 0 || source.height <= 0) return { x: 0, y: 0, w: 0, h: 0 };

  const sx = content.w / source.width;
  const sy = content.h / source.height;

  const left = content.x + bbox.x * sx;
  const top = content.y + bbox.y * sy;
  const right = left + bbox.w * sx;
  const bottom = top + bbox.h * sy;

  const clampedLeft = Math.max(content.x, Math.min(left, content.x + content.w));
  const clampedTop = Math.max(content.y, Math.min(top, content.y + content.h));
  const clampedRight = Math.max(content.x, Math.min(right, content.x + content.w));
  const clampedBottom = Math.max(content.y, Math.min(bottom, content.y + content.h));

  return {
    x: clampedLeft,
    y: clampedTop,
    w: Math.max(0, clampedRight - clampedLeft),
    h: Math.max(0, clampedBottom - clampedTop),
  };
}

/**
 * Which frame size to trust.
 *
 * `video.videoWidth/videoHeight` is the size of the frames the browser is decoding *right now*,
 * which is by definition the space the analytics worker's boxes were computed in — both read the
 * same stream. The registry's measured resolution is the fallback for the moment before metadata
 * loads, and after that it is only useful for noticing a disagreement.
 */
export function resolveSourceFrame(
  decoded: FrameSize | null,
  measured: FrameSize | null,
): FrameSize | null {
  if (decoded !== null && decoded.width > 0 && decoded.height > 0) return decoded;
  if (measured !== null && measured.width > 0 && measured.height > 0) return measured;
  return null;
}

/**
 * Whether the decoded stream and the registry's measured resolution disagree, and how much it
 * matters.
 *
 * A **scale** difference is harmless — 1920×1080 boxes drawn on a 1280×720 rendition of the same
 * scene land in the right place, because the transform normalises. An **aspect** difference is not:
 * it means the two are not the same framing, and every box is stretched. So this reports the second
 * and stays quiet about the first, which is the difference between a warning worth reading and
 * another yellow badge nobody looks at.
 */
export function aspectMismatch(decoded: FrameSize, measured: FrameSize): string | null {
  if (decoded.width <= 0 || decoded.height <= 0 || measured.width <= 0 || measured.height <= 0) {
    return null;
  }
  const a = decoded.width / decoded.height;
  const b = measured.width / measured.height;
  // 2% covers 854×480 (1.779) against a nominal 16:9 (1.778) and every other rounding of the same
  // intent; it does not cover 4:3 against 16:9.
  if (Math.abs(a - b) / b <= 0.02) return null;
  return (
    `The stream is decoding at ${String(decoded.width)}×${String(decoded.height)} but the registry ` +
    `measured ${String(measured.width)}×${String(measured.height)}. Those are different framings, ` +
    'not different sizes, so detection boxes may not line up.'
  );
}

export function parseResolution(value: string | null | undefined): FrameSize | null {
  if (value === null || value === undefined) return null;
  const match = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(value.trim());
  if (match === null) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The detections to draw at a given playhead.
 *
 * **Selected by presentation timestamp, never by arrival time.** `framePtsMs` is what the analytics
 * worker recorded and `video.currentTime * 1000` is the same clock, so a box drawn from it lands on
 * the frame it was computed from — after a seek, after a loop, and after the gateway replays a
 * buffered GOP on reconnect, which CLAUDE.md names as the case that turns an arrival-time tracker
 * into impossible velocities.
 *
 * One box per track: a 25 fps camera produces 25 rows per second per vehicle, and drawing all of
 * them inside a ±`toleranceMs` window paints a smear. The row nearest the playhead wins.
 */
export interface Detection {
  readonly id: string;
  readonly ptsMs: number;
  readonly trackId: number;
  readonly class: string;
  readonly bbox: Rect;
  readonly confidence: number;
  readonly plate: string | null;
}

export function detectionsAt(
  detections: readonly Detection[],
  playheadMs: number,
  toleranceMs = 120,
): Detection[] {
  const nearest = new Map<number, Detection>();
  for (const detection of detections) {
    const delta = Math.abs(detection.ptsMs - playheadMs);
    if (delta > toleranceMs) continue;
    const incumbent = nearest.get(detection.trackId);
    if (incumbent === undefined || delta < Math.abs(incumbent.ptsMs - playheadMs)) {
      nearest.set(detection.trackId, detection);
    }
  }
  return [...nearest.values()].sort((a, b) => a.trackId - b.trackId);
}
