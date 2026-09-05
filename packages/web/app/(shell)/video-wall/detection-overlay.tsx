'use client';

/**
 * Detection boxes, drawn over a tile.
 *
 * ## Aligned by presentation timestamp, never by wall clock
 *
 * The analytics worker records `framePtsMs` — the frame's own presentation timestamp — and on a
 * VOD tile `video.currentTime * 1000` is that same clock. So a box is fetched and drawn against the
 * playhead, and it lands on the frame it was computed from: after a seek, after the feed loops, and
 * after the gateway replays a buffered GOP on reconnect. CLAUDE.md names that last case as the one
 * that turns an arrival-time tracker into impossible velocities, and it is just as capable of
 * putting a box on the wrong car.
 *
 * ## Why a canvas rather than absolutely-positioned divs
 *
 * A busy junction is 20–40 boxes at 25 fps. As DOM nodes that is a mutation storm and a steadily
 * growing detached-node count — which is precisely what AC 8 ("no monotonic growth over ten
 * minutes") would catch. One canvas, cleared and redrawn per animation frame, allocates nothing.
 *
 * ## The transform
 *
 * `projectBox` in `src/lib/wall/overlay.ts`, tested against all six resolutions D1-05 measured
 * across the estate. Nothing here does arithmetic on a coordinate.
 */
import { useEffect, useRef, useState } from 'react';
import {
  aspectMismatch,
  detectionsAt,
  parseResolution,
  projectBox,
  resolveSourceFrame,
  type Detection,
} from '@/src/lib/wall/overlay';
import type { StreamDetections } from './types';

/** Seconds of detections fetched ahead of the playhead in one request. */
const WINDOW_S = 8;
/** Refetch when fewer than this many seconds of the window remain ahead of the playhead. */
const REFETCH_MARGIN_S = 3;

const CLASS_COLOUR: Record<string, string> = {
  car: '#38bdf8',
  motorcycle: '#f472b6',
  bus: '#facc15',
  truck: '#fb923c',
  auto_rickshaw: '#a78bfa',
  bicycle: '#4ade80',
  person: '#f87171',
  unknown: '#94a3b8',
};

export function DetectionOverlay({
  videoRef,
  cameraId,
  measuredResolution,
  enabled,
  onStatus,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  cameraId: string;
  measuredResolution: string | null;
  enabled: boolean;
  onStatus?: (status: { count: number; warning: string | null }) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const buffer = useRef<{ from: number; to: number; rows: Detection[] }>({
    from: 0,
    to: -1,
    rows: [],
  });
  const [warning, setWarning] = useState<string | null>(null);

  // ── Fetch: a sliding PTS window, kept just ahead of the playhead ─────────────────────────────
  useEffect(() => {
    if (!enabled) {
      buffer.current = { from: 0, to: -1, rows: [] };
      return;
    }
    let cancelled = false;
    const controller = new AbortController();

    const tick = async (): Promise<void> => {
      const video = videoRef.current;
      if (video === null || cancelled) return;
      const playheadMs = video.currentTime * 1000;
      if (playheadMs + REFETCH_MARGIN_S * 1000 < buffer.current.to) return;

      const from = Math.max(0, playheadMs - 1000);
      const to = from + WINDOW_S * 1000;
      const url =
        `/video-wall/stream/${cameraId}/detections` +
        `?fromPtsMs=${String(Math.round(from))}&toPtsMs=${String(Math.round(to))}&limit=500`;

      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const payload = (await response.json()) as StreamDetections;
        buffer.current = {
          from,
          to,
          rows: payload.detections.map((d) => ({
            id: d.id,
            ptsMs: d.ptsMs,
            trackId: d.trackId,
            class: d.class,
            bbox: d.bbox,
            confidence: d.confidence,
            plate: d.plate,
          })),
        };
      } catch {
        // A window that fails to load leaves the tile playing with no boxes, which is the correct
        // degradation: the video is the evidence, the overlay is an aid.
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [cameraId, enabled, videoRef]);

  // ── Draw: one canvas, one rAF loop, nothing allocated per box ────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (canvas === null || video === null) return;

    let frame = 0;
    let lastWarning: string | null = null;

    const draw = (): void => {
      frame = window.requestAnimationFrame(draw);

      const rect = video.getBoundingClientRect();
      // D2-07's lesson, in a different costume: a streamed App Router page renders this component
      // inside a hidden container where every rect is 0x0. Drawing then is not wrong, it is
      // *invisible and wasteful*, and it caches a bad size.
      if (rect.width <= 0 || rect.height <= 0) return;

      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(rect.width * dpr))
        canvas.width = Math.round(rect.width * dpr);
      if (canvas.height !== Math.round(rect.height * dpr)) {
        canvas.height = Math.round(rect.height * dpr);
      }

      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (!enabled) return;

      const decoded =
        video.videoWidth > 0 ? { width: video.videoWidth, height: video.videoHeight } : null;
      const measured = parseResolution(measuredResolution);
      const source = resolveSourceFrame(decoded, measured);
      if (source === null) return;

      const mismatch =
        decoded !== null && measured !== null ? aspectMismatch(decoded, measured) : null;
      if (mismatch !== lastWarning) {
        lastWarning = mismatch;
        setWarning(mismatch);
      }

      const visible = detectionsAt(buffer.current.rows, video.currentTime * 1000);
      onStatus?.({ count: visible.length, warning: mismatch });

      ctx.lineWidth = 1.5;
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'bottom';

      for (const detection of visible) {
        const box = projectBox(detection.bbox, source, { width: rect.width, height: rect.height });
        if (box.w <= 0 || box.h <= 0) continue;

        const colour = CLASS_COLOUR[detection.class] ?? CLASS_COLOUR['unknown'] ?? '#94a3b8';
        ctx.strokeStyle = colour;
        ctx.strokeRect(box.x, box.y, box.w, box.h);

        // The plate, when one was read. Rendered above the box so it never covers the vehicle, and
        // rendered as text rather than a claim: it is what OCR read, not an identification.
        const label = detection.plate ?? '';
        if (label !== '') {
          const width = ctx.measureText(label).width + 6;
          ctx.fillStyle = 'rgba(2, 6, 23, 0.85)';
          ctx.fillRect(box.x, Math.max(0, box.y - 13), width, 13);
          ctx.fillStyle = colour;
          ctx.fillText(label, box.x + 3, Math.max(11, box.y - 2));
        }
      }
    };

    frame = window.requestAnimationFrame(draw);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [videoRef, enabled, measuredResolution, onStatus]);

  return (
    <>
      <canvas
        ref={canvasRef}
        data-testid="detection-overlay"
        data-camera={cameraId}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full"
      />
      {warning === null ? null : (
        <p className="pointer-events-none absolute inset-x-2 bottom-8 rounded bg-amber-950/85 px-2 py-1 text-[10px] leading-tight text-amber-200">
          {warning}
        </p>
      )}
    </>
  );
}
