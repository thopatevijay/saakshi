/**
 * The basemap server — the reason the map makes **zero external requests**.
 *
 * Two assets, both on disk, both gitignored because they are build outputs rather than source:
 *
 *   `/basemap/gujarat.pmtiles`                     the Gujarat vector-tile extract (28 MB, z0–z12)
 *   `/basemap/fonts/{fontstack}/{range}.pbf`       signed-distance-field label glyphs
 *
 * ## Range requests are not optional here
 *
 * PMTiles is a single file with an internal directory, and the client library reads it by asking
 * for byte ranges — a few kilobytes of header, then a directory page, then the handful of tiles the
 * viewport needs. Without `Range` support the browser would download all 28 MB to draw one tile, so
 * a handler that ignores `Range` does not merely lose an optimisation, it makes the map unusable.
 * Hence the 206 path below, and `Accept-Ranges: bytes` on every response so the library knows it
 * may ask.
 *
 * ## Why the glyphs are here too
 *
 * MapLibre's default `glyphs` URL points at a CDN. Self-hosting the tiles and then letting the
 * labels phone home would defeat the entire exercise, so `scripts/build-basemap.sh` vendors the
 * ranges and this handler serves them. The style names the local URL explicitly — see
 * `basemap-style.ts`.
 *
 * Reachable only with a session: the route is inside `middleware.ts`'s matcher, so an anonymous
 * request is redirected to the login screen rather than handed the estate's basemap.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';

export const dynamic = 'force-dynamic';
/** Node, not edge: this streams a file off local disk. */
export const runtime = 'nodejs';

const TILES_FILE = 'gujarat.pmtiles';
const FONTS_DIR = 'basemap-fonts';

/**
 * Where `data/` lives.
 *
 * `PMTILES_PATH` (already in `.env.example`) wins. Otherwise walk up from the working directory,
 * because `next dev` runs in `packages/web` and `next start` may run from the repo root, and a
 * hardcoded `../../data` is correct in exactly one of those.
 */
function dataDir(): string | null {
  const configured = process.env['PMTILES_PATH'];
  if (configured !== undefined && configured !== '') {
    const resolved = path.resolve(process.cwd(), configured);
    if (existsSync(resolved)) return path.dirname(resolved);
  }
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'data');
    if (existsSync(path.join(candidate, TILES_FILE))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const SEGMENT = /^[A-Za-z0-9 _.,-]+$/;

/**
 * Request path → a file inside `data/`, or `null`.
 *
 * Allow-list, not a deny-list: the two shapes below are the only ones that resolve, every segment
 * must match `SEGMENT`, and the resolved path is re-checked to be inside `data/`. A handler that
 * joins user input onto a directory and hopes is how a traversal bug ships.
 */
function resolveAsset(root: string, segments: string[]): { file: string; type: string } | null {
  if (segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..')) return null;

  const [first, second, third] = segments;
  let file: string;
  let type: string;

  if (segments.length === 1 && first === TILES_FILE) {
    file = path.join(root, TILES_FILE);
    type = 'application/octet-stream';
  } else if (
    segments.length === 3 &&
    first === 'fonts' &&
    second !== undefined &&
    third !== undefined &&
    third.endsWith('.pbf')
  ) {
    // MapLibre sends the font stack URL-encoded with spaces, and may send several comma-separated
    // names in fallback order. The vendored directories use underscores; take the first stack that
    // is actually on disk.
    const stacks = second.split(',').map((s) => s.trim().replaceAll(' ', '_'));
    const found = stacks
      .map((stack) => path.join(root, FONTS_DIR, stack, third))
      .find((candidate) => existsSync(candidate));
    if (found === undefined) return null;
    file = found;
    type = 'application/x-protobuf';
  } else {
    return null;
  }

  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return null;
  return existsSync(resolved) ? { file: resolved, type } : null;
}

/** `bytes=start-end`, with both ends optional. Anything else is ignored and the full file sent. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, rawStart, rawEnd] = match;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // `bytes=-500` — the last 500 bytes. PMTiles does not use this, but a correct handler answers it.
    if (rawEnd === '') return null;
    start = Math.max(0, size - Number(rawEnd));
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ asset: string[] }> },
): Promise<Response> {
  const root = dataDir();
  if (root === null) {
    return new Response(
      'basemap extract not found — run scripts/build-basemap.sh (see docs/basemap-setup.md)',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const { asset } = await context.params;
  const target = resolveAsset(root, asset);
  if (target === null) return new Response('not found', { status: 404 });

  const { size } = statSync(target.file);
  const range = parseRange(request.headers.get('range'), size);

  const headers = new Headers({
    'content-type': target.type,
    'accept-ranges': 'bytes',
    // Immutable: the extract is rebuilt under a new deploy, never edited in place. Without this the
    // browser revalidates every directory page on every pan.
    'cache-control': 'public, max-age=31536000, immutable',
  });

  if (range === null) {
    headers.set('content-length', String(size));
    return new Response(Readable.toWeb(createReadStream(target.file)) as ReadableStream, {
      status: 200,
      headers,
    });
  }

  headers.set('content-length', String(range.end - range.start + 1));
  headers.set('content-range', `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`);
  return new Response(
    Readable.toWeb(
      createReadStream(target.file, { start: range.start, end: range.end }),
    ) as ReadableStream,
    { status: 206, headers },
  );
}

/** PMTiles issues a HEAD to learn the length before its first range read. */
export async function HEAD(
  request: Request,
  context: { params: Promise<{ asset: string[] }> },
): Promise<Response> {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}
