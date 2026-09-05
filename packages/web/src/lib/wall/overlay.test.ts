import { describe, expect, it } from 'vitest';
import {
  aspectMismatch,
  contentRect,
  detectionsAt,
  parseResolution,
  projectBox,
  resolveSourceFrame,
  type Detection,
  type FrameSize,
} from './overlay';

/**
 * The estate, measured by D1-05 — not a set of round numbers chosen to make the maths easy.
 * 854×480 is the modal camera and its aspect (1.7792) is *not* exactly 16:9 (1.7778), which is
 * precisely the kind of near-miss a naive tolerance check flags as a mismatch.
 */
const ESTATE: { name: string; size: FrameSize; count: number }[] = [
  { name: '854x480', size: { width: 854, height: 480 }, count: 12 },
  { name: '1920x1080', size: { width: 1920, height: 1080 }, count: 11 },
  { name: '1280x960', size: { width: 1280, height: 960 }, count: 3 },
  { name: '1280x720', size: { width: 1280, height: 720 }, count: 2 },
  { name: '640x480', size: { width: 640, height: 480 }, count: 1 },
  { name: '960x576', size: { width: 960, height: 576 }, count: 1 },
];

it('covers the whole estate D1-05 measured', () => {
  expect(ESTATE.reduce((n, r) => n + r.count, 0)).toBe(30);
});

describe('contentRect — where `object-fit: contain` actually draws the frame', () => {
  it('fills exactly when the aspect ratios match', () => {
    expect(contentRect({ width: 854, height: 480 }, { width: 427, height: 240 })).toEqual({
      x: 0,
      y: 0,
      w: 427,
      h: 240,
    });
  });

  it('letterboxes a 16:9 stream in a square tile', () => {
    const rect = contentRect({ width: 1920, height: 1080 }, { width: 400, height: 400 });
    expect(rect.w).toBeCloseTo(400, 6);
    expect(rect.h).toBeCloseTo(225, 6);
    expect(rect.x).toBeCloseTo(0, 6);
    expect(rect.y).toBeCloseTo(87.5, 6);
  });

  it('pillarboxes a 4:3 stream in a 16:9 tile', () => {
    const rect = contentRect({ width: 640, height: 480 }, { width: 480, height: 270 });
    expect(rect.h).toBeCloseTo(270, 6);
    expect(rect.w).toBeCloseTo(360, 6);
    expect(rect.x).toBeCloseTo(60, 6);
    expect(rect.y).toBeCloseTo(0, 6);
  });

  it('never exceeds the element, for every resolution in the estate, in a 3x3 tile', () => {
    for (const { name, size } of ESTATE) {
      const element = { width: 512, height: 288 };
      const rect = contentRect(size, element);
      expect(rect.w, name).toBeLessThanOrEqual(element.width + 1e-9);
      expect(rect.h, name).toBeLessThanOrEqual(element.height + 1e-9);
      // One dimension is always exactly filled — that is what `contain` means.
      const fills =
        Math.abs(rect.w - element.width) < 1e-9 || Math.abs(rect.h - element.height) < 1e-9;
      expect(fills, name).toBe(true);
    }
  });

  it('degrades to the element rather than dividing by zero before layout', () => {
    expect(contentRect({ width: 0, height: 0 }, { width: 300, height: 200 })).toEqual({
      x: 0,
      y: 0,
      w: 300,
      h: 200,
    });
  });
});

describe('projectBox — the transform the acceptance criterion is about', () => {
  it('maps the full frame onto the drawn content rect, at every estate resolution', () => {
    const element = { width: 500, height: 500 };
    for (const { name, size } of ESTATE) {
      const whole = { x: 0, y: 0, w: size.width, h: size.height };
      const projected = projectBox(whole, size, element);
      const content = contentRect(size, element);
      expect(projected.x, name).toBeCloseTo(content.x, 6);
      expect(projected.y, name).toBeCloseTo(content.y, 6);
      expect(projected.w, name).toBeCloseTo(content.w, 6);
      expect(projected.h, name).toBeCloseTo(content.h, 6);
    }
  });

  it('maps the frame centre to the centre of the drawn content, at every estate resolution', () => {
    const element = { width: 640, height: 360 };
    for (const { name, size } of ESTATE) {
      const centre = {
        x: size.width / 2 - 10,
        y: size.height / 2 - 10,
        w: 20,
        h: 20,
      };
      const projected = projectBox(centre, size, element);
      expect(projected.x + projected.w / 2, name).toBeCloseTo(element.width / 2, 6);
      expect(projected.y + projected.h / 2, name).toBeCloseTo(element.height / 2, 6);
    }
  });

  it('is scale-invariant: the same fraction of the frame lands in the same place', () => {
    // A box a quarter across and a third down, on two very different cameras rendered identically.
    const element = { width: 480, height: 270 };
    const a = projectBox(
      { x: 1920 / 4, y: 1080 / 3, w: 1920 / 8, h: 1080 / 8 },
      { width: 1920, height: 1080 },
      element,
    );
    const b = projectBox(
      { x: 1280 / 4, y: 720 / 3, w: 1280 / 8, h: 720 / 8 },
      { width: 1280, height: 720 },
      element,
    );
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
    expect(a.w).toBeCloseTo(b.w, 6);
    expect(a.h).toBeCloseTo(b.h, 6);
  });

  it('accounts for the letterbox offset — the bug this module exists to prevent', () => {
    // 640x480 (4:3) in a 16:9 tile is pillarboxed by 60px each side. A transform that multiplied by
    // element.width would put the frame's left edge at x=0 instead of x=60.
    const projected = projectBox(
      { x: 0, y: 0, w: 64, h: 48 },
      { width: 640, height: 480 },
      { width: 480, height: 270 },
    );
    expect(projected.x).toBeCloseTo(60, 6);
    expect(projected.w).toBeCloseTo(36, 6);
  });

  it('clamps a box that runs off the frame, rather than drawing into the letterbox bar', () => {
    const projected = projectBox(
      { x: 600, y: 400, w: 200, h: 200 },
      { width: 640, height: 480 },
      { width: 480, height: 270 },
    );
    const content = contentRect({ width: 640, height: 480 }, { width: 480, height: 270 });
    expect(projected.x + projected.w).toBeLessThanOrEqual(content.x + content.w + 1e-9);
    expect(projected.y + projected.h).toBeLessThanOrEqual(content.y + content.h + 1e-9);
  });

  it('returns nothing when the source frame is unknown', () => {
    expect(
      projectBox({ x: 1, y: 1, w: 1, h: 1 }, { width: 0, height: 0 }, { width: 10, height: 10 }),
    ).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('resolveSourceFrame', () => {
  it('prefers what the browser is decoding over what the registry measured', () => {
    expect(resolveSourceFrame({ width: 854, height: 480 }, { width: 1920, height: 1080 })).toEqual({
      width: 854,
      height: 480,
    });
  });

  it('falls back to the measured resolution before metadata loads', () => {
    expect(resolveSourceFrame({ width: 0, height: 0 }, { width: 960, height: 576 })).toEqual({
      width: 960,
      height: 576,
    });
    expect(resolveSourceFrame(null, null)).toBeNull();
  });
});

describe('aspectMismatch', () => {
  it('stays quiet about a pure scale difference — the transform handles it', () => {
    expect(aspectMismatch({ width: 1280, height: 720 }, { width: 1920, height: 1080 })).toBeNull();
  });

  it('stays quiet about 854x480 against nominal 16:9, which is a rounding, not a framing', () => {
    expect(aspectMismatch({ width: 854, height: 480 }, { width: 1920, height: 1080 })).toBeNull();
  });

  it('warns when the framings genuinely differ', () => {
    const message = aspectMismatch({ width: 640, height: 480 }, { width: 1920, height: 1080 });
    expect(message).toContain('different framings');
    expect(message).toContain('640×480');
  });
});

describe('parseResolution', () => {
  it('reads the registry’s measured strings', () => {
    expect(parseResolution('1280x960')).toEqual({ width: 1280, height: 960 });
    expect(parseResolution(' 854 × 480 ')).toEqual({ width: 854, height: 480 });
  });

  it('treats anything else as absent rather than guessing', () => {
    expect(parseResolution(null)).toBeNull();
    expect(parseResolution('unknown')).toBeNull();
    expect(parseResolution('1920x')).toBeNull();
  });
});

describe('detectionsAt — selection by PTS, never by arrival time', () => {
  const detection = (over: Partial<Detection>): Detection => ({
    id: crypto.randomUUID(),
    ptsMs: 0,
    trackId: 1,
    class: 'car',
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    confidence: 0.9,
    plate: null,
    ...over,
  });

  it('takes the row nearest the playhead for each track, not every row in the window', () => {
    const rows = [
      detection({ trackId: 1, ptsMs: 1000 }),
      detection({ trackId: 1, ptsMs: 1040 }),
      detection({ trackId: 1, ptsMs: 1080 }),
      detection({ trackId: 2, ptsMs: 1040 }),
    ];
    const drawn = detectionsAt(rows, 1040);
    expect(drawn).toHaveLength(2);
    expect(drawn[0]?.ptsMs).toBe(1040);
  });

  it('drops rows outside the tolerance, so a wall of stale boxes never accumulates', () => {
    const rows = [detection({ trackId: 1, ptsMs: 1000 }), detection({ trackId: 2, ptsMs: 5000 })];
    expect(detectionsAt(rows, 1000, 120).map((d) => d.trackId)).toEqual([1]);
  });

  it('is empty when the playhead is nowhere near any detection', () => {
    expect(detectionsAt([detection({ ptsMs: 1000 })], 90_000)).toEqual([]);
  });

  it('returns tracks in a stable order, so boxes do not flicker between frames', () => {
    const rows = [
      detection({ trackId: 7, ptsMs: 500 }),
      detection({ trackId: 2, ptsMs: 500 }),
      detection({ trackId: 5, ptsMs: 500 }),
    ];
    expect(detectionsAt(rows, 500).map((d) => d.trackId)).toEqual([2, 5, 7]);
  });
});
