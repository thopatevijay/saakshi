/**
 * Loading one PTS window of detections for the overlay (D4-17).
 *
 * ## Why the window and the limit are set together
 *
 * The API returns **one analytics run per frame** — about 15 boxes per frame on a busy junction at
 * 25 fps, so ~1,500 rows for four seconds. The overlay used to ask for eight seconds in 500 rows;
 * on a VOD camera analysed ~25 times those 500 rows covered 40 ms, and nothing was ever drawn.
 * `WINDOW_MS` and `PAGE_LIMIT` are now sized so one request normally covers the window, and the
 * server's cap (`DETECTIONS_MAX_LIMIT` in `packages/api/src/routes/streams.ts`) was raised to match.
 *
 * ## A cut response is never taken for a complete one
 *
 * When the server stops at the limit it says so (`truncated`, `nextFromPtsMs`). This loader asks
 * again from there until the window is covered. If it gives up after `MAX_PAGES` it reports how far
 * it actually got (`coveredToMs`), so the overlay refetches from that point rather than believing
 * it holds the whole window and drawing nothing past the cut.
 */
import type { Detection } from './overlay';

/** Milliseconds of detections loaded per window. */
export const WINDOW_MS = 4000;
/** Rows asked for per request; the API accepts up to 2000. */
export const PAGE_LIMIT = 2000;
/** A runaway guard: four pages is ~8,000 rows, far beyond any measured window. */
export const MAX_PAGES = 4;

/** The fields of one API page this loader relies on. */
export interface DetectionsPage {
  truncated: boolean;
  nextFromPtsMs: number | null;
  detections: readonly Detection[];
}

export type FetchPage = (fromMs: number, toMs: number, limit: number) => Promise<DetectionsPage>;

export interface LoadedWindow {
  fromMs: number;
  /** How far the rows actually reach: `toMs` when complete, the last cut point when not. */
  coveredToMs: number;
  complete: boolean;
  rows: Detection[];
}

export async function loadDetectionWindow(
  fetchPage: FetchPage,
  fromMs: number,
  toMs: number,
  options: { limit?: number; maxPages?: number } = {},
): Promise<LoadedWindow> {
  const limit = options.limit ?? PAGE_LIMIT;
  const maxPages = options.maxPages ?? MAX_PAGES;
  const rows: Detection[] = [];
  let cursor = fromMs;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor, toMs, limit);
    rows.push(...result.detections);
    const next = result.nextFromPtsMs;
    // A cursor that does not advance would ask the same question forever; treat it as complete
    // only when the server said it was, otherwise stop and report the honest extent.
    if (!result.truncated) return { fromMs, coveredToMs: toMs, complete: true, rows };
    if (next === null || next <= cursor) break;
    cursor = next;
  }
  return { fromMs, coveredToMs: cursor, complete: false, rows };
}

/** The overlay's request URL for one page, through the wall's same-origin proxy. */
export function detectionsUrl(
  cameraId: string,
  fromMs: number,
  toMs: number,
  limit: number,
): string {
  return (
    `/video-wall/stream/${cameraId}/detections` +
    `?fromPtsMs=${String(Math.round(fromMs))}&toPtsMs=${String(Math.round(toMs))}` +
    `&limit=${String(limit)}`
  );
}
