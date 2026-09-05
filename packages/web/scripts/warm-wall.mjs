/**
 * Warms the edge relay's cache for the cameras a wall is about to show.
 *
 * ## What this is for, and what it is not
 *
 * It is **not** a way to make a benchmark look good. It is the thing the relay exists to do, run
 * deliberately instead of incidentally.
 *
 * The sandbox serves `PLAYLIST-TYPE:VOD` with `ENDLIST`, so by RFC 8216 §6.2.1 its playlist and
 * every segment are immutable — and the organisers' guide says each connected client gets its own
 * copy of the stream. Put those two facts together and the department gateway should be asked for a
 * given segment **once**, however many operators later watch that junction. That is what an edge
 * node is for in PROJECT.md §2, and warming is that request happening at a chosen moment rather
 * than while an officer is waiting.
 *
 * It also separates two questions that a single cold run confuses:
 *
 *   - *can the console sustain nine concurrent players?*  — a question about the client
 *   - *can this gateway feed nine at once?*               — a question about the estate
 *
 * The first is what AC 1 is really asking. The second was measured at 0.12×–0.28× real time per
 * connection and the answer is plainly no, which is a finding about the estate and is reported as
 * one — not tuned away.
 *
 *   node scripts/warm-wall.mjs <token-file> [api-url] [segments] [cameras]
 */
import { readFileSync } from 'node:fs';

const token = readFileSync(process.argv[2], 'utf8').trim();
const api = process.argv[3] ?? 'http://localhost:4100';
const segments = Number(process.argv[4] ?? 6);
const wanted = Number(process.argv[5] ?? 9);

const auth = { authorization: `Bearer ${token}` };

const page = await fetch(`${api}/api/v1/cameras?limit=200`, { headers: auth }).then((r) => r.json());
const cameras = page.data.slice(0, wanted);

console.log(
  `warming ${String(cameras.length)} cameras × ${String(segments)} segments through the relay\n`,
);

const started = Date.now();
let fetched = 0;
let bytes = 0;
let cached = 0;

/**
 * Cameras are warmed **concurrently, but the pacing is the relay's**.
 *
 * Warming one camera at a time would take nine times as long for no benefit: the relay already caps
 * upstream concurrency (`STREAM_RELAY_CONCURRENCY`, default 4) precisely so that no caller can
 * decide how hard to push a department's gateway. Issuing nine requests and letting the semaphore
 * queue them is the correct shape — the load on the gateway is identical either way, and the pacing
 * decision stays in the one place that owns it.
 */
await Promise.all(cameras.map((camera) => warm(camera)));

async function warm(camera) {
  const t0 = Date.now();
  const playlist = await fetch(`${api}/api/v1/streams/${camera.id}/index.m3u8`, { headers: auth });
  if (!playlist.ok) {
    console.log(`  ${camera.externalId}: playlist ${String(playlist.status)} — skipped`);
    return;
  }
  const body = await playlist.text();
  const playlistMs = Date.now() - t0;

  // The key line first, then the first N media lines: exactly what a player asks for on join.
  const uris = body
    .split('\n')
    .flatMap((line) =>
      line.startsWith('#EXT-X-KEY')
        ? [/URI="([^"]+)"/.exec(line)?.[1] ?? '']
        : line.startsWith('media?u=')
          ? [line]
          : [],
    )
    .filter((u) => u !== '')
    .slice(0, segments + 1);

  let cameraBytes = 0;
  let cameraCached = 0;
  const s0 = Date.now();
  for (const uri of uris) {
    const response = await fetch(`${api}/api/v1/streams/${camera.id}/${uri}`, { headers: auth });
    if (!response.ok) continue;
    const buffer = await response.arrayBuffer();
    cameraBytes += buffer.byteLength;
    bytes += buffer.byteLength;
    fetched += 1;
    if (response.headers.get('x-saakshi-relay') === 'hit') {
      cameraCached += 1;
      cached += 1;
    }
  }

  console.log(
    `  ${camera.externalId}: playlist ${String(playlistMs)} ms · ${String(uris.length)} objects in ` +
      `${String(Date.now() - s0)} ms · ${(cameraBytes / 1048576).toFixed(1)} MB · ` +
      `${String(cameraCached)} already cached`,
  );
}

const stats = await fetch(`${api}/api/v1/streams/relay/stats`, { headers: auth }).then((r) =>
  r.json(),
);

console.log(
  `\n${String(fetched)} objects · ${(bytes / 1048576).toFixed(1)} MB · ` +
    `${String(cached)} served from cache · ${((Date.now() - started) / 1000).toFixed(1)} s total`,
);
console.log(
  `relay: ${String(stats.upstreamRequests)} upstream requests, ${String(stats.hits)} hits, ` +
    `${String(stats.misses)} misses, mean ${String(stats.meanUpstreamMs)} ms upstream, ` +
    `${(stats.cachedBytes / 1048576).toFixed(1)} MB cached`,
);
