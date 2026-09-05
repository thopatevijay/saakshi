/**
 * Records the video wall to an MP4 — the raw material D3-11 and D4-03 cut their demos from.
 *
 * CDP's `Page.startScreencast` rather than a desktop screen recorder, for three reasons that all
 * matter to a submission: it is **reproducible** (anyone can re-run it and get the same shot), it
 * captures the page and nothing else (no menu bar, no cursor, no notification sliding in over the
 * evidence), and it runs headless so it does not depend on whose laptop is in front of the camera.
 *
 * Frames arrive as base64 JPEGs at whatever rate the compositor produces them, which is *not*
 * constant — a wall waiting on a throttled gateway paints rarely. So each frame is written with its
 * own timestamp and ffmpeg is handed a concat list with real per-frame durations; encoding at a
 * nominal fps instead would speed the recording up or slow it down by however much the gateway was
 * misbehaving, and the demo would be a lie about the product's responsiveness.
 *
 *   node scripts/record-wall.mjs <token-file> [seconds] [base-url] [out]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, authenticate, navigate, waitFor } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

const token = process.argv[2];
const seconds = Number(process.argv[3] ?? 40);
const base = process.argv[4] ?? 'http://localhost:3100';
const out = process.argv[5] ?? path.join(repo, 'docs/recordings/video-wall-grid.mp4');

const frames = path.join(repo, '.prp/frames');

const TILES_LAID_OUT = `[...document.querySelectorAll('[data-testid="wall-tile"]')].filter((t) => t.getBoundingClientRect().height > 0).length`;

async function main() {
  const { readFileSync } = await import('node:fs');
  const bearer = readFileSync(token, 'utf8').trim();

  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  mkdirSync(path.dirname(out), { recursive: true });

  const cdp = await openBrowser({ width: 1600, height: 900 });
  await authenticate(cdp, bearer, 'admin', base);
  await navigate(cdp, `${base}/video-wall`);
  await waitFor(cdp, `${TILES_LAID_OUT} >= 9`, { label: 'nine laid-out tiles' });

  // Let the wall settle before the camera rolls: a recording that opens on nine grey rectangles
  // filling in is a recording of our start-up sequence, not of the product.
  //
  // Four minutes, not thirty seconds, and the reason is the gateway rather than the console: a 6 s
  // segment was measured arriving in 22–49 s, so nine tiles need minutes before there is anything
  // to film. Warming the relay first (`npm run warm:wall`) shortens this to seconds; without it,
  // this wait is the sandbox's throttle and nothing else.
  console.log('  warming the wall…');
  await cdp.evaluate(`new Promise((r) => setTimeout(r, 240000))`);

  const written = [];
  const started = Date.now();

  const off = cdp.on('Page.screencastFrame', (params) => {
    const file = path.join(frames, `f${String(written.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(params.data, 'base64'));
    written.push({ file, at: Date.now() - started });
    void cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId });
  });

  console.log(`  recording ${String(seconds)} s…`);
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 85,
    maxWidth: 1600,
    maxHeight: 900,
    everyNthFrame: 1,
  });
  await cdp.evaluate(`new Promise((r) => setTimeout(r, ${String(seconds * 1000)}))`);
  await cdp.send('Page.stopScreencast');
  off();
  await cdp.close();

  if (written.length < 2) throw new Error(`only ${String(written.length)} frames captured`);

  // Real durations, so the recording plays at the speed the wall actually ran at.
  const lines = [];
  for (let i = 0; i < written.length; i += 1) {
    const next = written[i + 1]?.at ?? written[i].at + 100;
    lines.push(`file '${written[i].file}'`);
    lines.push(`duration ${((next - written[i].at) / 1000).toFixed(3)}`);
  }
  lines.push(`file '${written[written.length - 1].file}'`);
  const list = path.join(frames, 'concat.txt');
  writeFileSync(list, lines.join('\n'));

  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      // Two things that both fail loudly and unhelpfully if omitted:
      //   `scale=trunc(iw/2)*2:trunc(ih/2)*2` — the viewport is 1600×813 once the browser chrome is
      //     subtracted, and libx264 with yuv420p cannot encode an odd dimension. The error is
      //     "Error opening output files: Invalid argument", which says nothing about height.
      //   `fps=25` as a *filter*, not `-r` — `-r` alongside the variable-rate concat input is
      //     rejected as contradictory ("One of -r/-fpsmax was specified together a non-CFR -vsync").
      //     The filter resamples the real per-frame timings to constant 25 fps, which is what keeps
      //     the recording playing at the speed the wall actually ran at.
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=25',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '24',
      out,
    ],
    { stdio: 'inherit' },
  );

  console.log(
    `  ${String(written.length)} frames over ${String((written[written.length - 1].at / 1000).toFixed(1))} s → ${out}`,
  );
  rmSync(frames, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
