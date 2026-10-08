import { describe, expect, it } from 'vitest';
import type { Detection } from './overlay';
import {
  PAGE_LIMIT,
  WINDOW_MS,
  detectionsUrl,
  loadDetectionWindow,
  type DetectionsPage,
  type FetchPage,
} from './detections-window';

const det = (ptsMs: number, trackId: number): Detection => ({
  id: `${String(ptsMs)}-${String(trackId)}`,
  ptsMs,
  trackId,
  class: 'car',
  bbox: { x: 0, y: 0, w: 10, h: 10 },
  confidence: 0.9,
  plate: null,
});

/**
 * A fake server with the real contract: rows ordered by PTS, cut at `limit` on a frame boundary,
 * `truncated` + `nextFromPtsMs` when it stopped early. 40 ms frames, `perFrame` boxes each.
 */
function fakeServer(perFrame: number): { fetchPage: FetchPage; calls: [number, number][] } {
  const calls: [number, number][] = [];
  const fetchPage: FetchPage = (fromMs, toMs, limit) => {
    calls.push([fromMs, toMs]);
    const all: Detection[] = [];
    for (let pts = Math.ceil(fromMs / 40) * 40; pts <= toMs; pts += 40) {
      for (let k = 0; k < perFrame; k += 1) all.push(det(pts, k));
    }
    const probe = all[limit];
    if (probe === undefined) {
      return Promise.resolve({ truncated: false, nextFromPtsMs: null, detections: all });
    }
    const page: DetectionsPage = {
      truncated: true,
      nextFromPtsMs: probe.ptsMs,
      detections: all.slice(0, limit).filter((d) => d.ptsMs < probe.ptsMs),
    };
    return Promise.resolve(page);
  };
  return { fetchPage, calls };
}

describe('loadDetectionWindow', () => {
  it('covers the window in one request at measured cam04 density (~15 boxes per frame)', async () => {
    const { fetchPage, calls } = fakeServer(15);
    const loaded = await loadDetectionWindow(fetchPage, 39_000, 39_000 + WINDOW_MS);
    expect(calls).toHaveLength(1);
    expect(loaded.complete).toBe(true);
    expect(loaded.coveredToMs).toBe(39_000 + WINDOW_MS);
    expect(loaded.rows.length).toBeLessThanOrEqual(PAGE_LIMIT);
  });

  it('pages past a truncated response until the whole window is covered', async () => {
    const { fetchPage, calls } = fakeServer(15);
    const loaded = await loadDetectionWindow(fetchPage, 0, 4000, { limit: 500 });
    expect(calls.length).toBeGreaterThan(1);
    // Each later page starts exactly where the previous one stopped.
    expect(calls[1]?.[0]).toBeGreaterThan(0);
    expect(loaded.complete).toBe(true);
    const frames = new Set(loaded.rows.map((d) => d.ptsMs));
    expect(frames.size).toBe(4000 / 40 + 1);
    expect(loaded.rows).toHaveLength(frames.size * 15);
    // Nothing fetched twice.
    expect(new Set(loaded.rows.map((d) => d.id)).size).toBe(loaded.rows.length);
  });

  it('never reports a cut window as complete when it runs out of pages', async () => {
    const { fetchPage } = fakeServer(15);
    const loaded = await loadDetectionWindow(fetchPage, 0, 4000, { limit: 300, maxPages: 2 });
    expect(loaded.complete).toBe(false);
    expect(loaded.coveredToMs).toBeLessThan(4000);
    // The covered extent is honest: every row lies before it, and the next frame is not held.
    expect(Math.max(...loaded.rows.map((d) => d.ptsMs))).toBeLessThan(loaded.coveredToMs);
  });

  it('stops rather than loops when a truncated page does not advance the cursor', async () => {
    let calls = 0;
    const stuck: FetchPage = () => {
      calls += 1;
      return Promise.resolve({ truncated: true, nextFromPtsMs: 0, detections: [det(0, 1)] });
    };
    const loaded = await loadDetectionWindow(stuck, 0, 4000);
    expect(calls).toBe(1);
    expect(loaded.complete).toBe(false);
    expect(loaded.coveredToMs).toBe(0);
  });
});

describe('detectionsUrl', () => {
  it('rounds the window and carries the limit through the same-origin proxy', () => {
    expect(detectionsUrl('cam', 1000.6, 5000.2, 2000)).toBe(
      '/video-wall/stream/cam/detections?fromPtsMs=1001&toPtsMs=5000&limit=2000',
    );
  });
});
