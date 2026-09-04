/**
 * `npm run adapter:probe -- --camera cam01 [--seek 39600] [--kind hls]`
 *
 * Capability discovery against a real camera, from the command line. This is the tool that answers
 * "what is actually on the other end of this URL" for a camera whose department declared nothing
 * but a name — which, for the sandbox catalogue, is every camera.
 *
 * With `--seek` it also writes a JPEG from that offset and reports its mean brightness, which is
 * how the seek is *proved* rather than asserted: the sandbox recording runs 21:00 → 09:00, so
 * roughly nine of twelve hours are dark. A frame from offset 39600 that comes back bright is a
 * frame that genuinely came from ~08:00, not from the start of the file.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';
import { loadEnv } from '../env.js';
import { createAdapterRegistry } from './index.js';
import { createHlsAdapter } from './hls.js';
import { run } from './ffmpeg.js';
import { AdapterError, type AdapterCameraConfig, type AdapterKind } from './types.js';

interface Args {
  camera: string;
  seek?: number;
  kind: AdapterKind;
  endpoint?: string;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const camera = get('--camera');
  if (camera === undefined) {
    throw new Error('usage: adapter:probe --camera <id> [--seek <seconds>] [--kind hls|rtsp|…]');
  }
  const seekRaw = get('--seek');
  return {
    camera,
    ...(seekRaw === undefined ? {} : { seek: Number(seekRaw) }),
    kind: (get('--kind') ?? 'hls') as AdapterKind,
    ...(get('--endpoint') === undefined ? {} : { endpoint: get('--endpoint') as string }),
    outDir: get('--out') ?? 'recon-out/probe',
  };
}

/** Mean luma of a JPEG, via ffmpeg's signalstats. Dark night frame vs bright daylight frame. */
async function meanBrightness(imagePath: string): Promise<number | null> {
  const result = await run('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-i',
    imagePath,
    '-vf',
    'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f',
    'null',
    '-',
  ]);
  const match = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(result.stderr);
  return match?.[1] === undefined ? null : Number(Number(match[1]).toFixed(1));
}

const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
const registry = createAdapterRegistry(env);

// `GET /api/ingest` is the contract; the URL pattern is not. The default below mirrors what recon
// found, and `--endpoint` overrides it — no template is ever the only path.
const defaultEndpoint =
  args.kind === 'hls'
    ? `https://${env.SENTINEL_HOST ?? 'localhost'}/${args.camera}/index.m3u8`
    : `rtsp://127.0.0.1:8554/${args.camera}`;

const cfg: AdapterCameraConfig = {
  externalId: args.camera,
  adapterKind: args.kind,
  endpoints: { [args.kind]: args.endpoint ?? defaultEndpoint },
};

const adapter = registry.get(args.kind);

try {
  console.log(`\nprobing ${args.camera} over ${args.kind} …`);
  console.log(`  endpoint: ${cfg.endpoints[args.kind] ?? '(none)'}`);

  const caps = await adapter.probe(cfg);

  const resolution =
    caps.width === null || caps.height === null
      ? '(unknown)'
      : `${String(caps.width)}x${String(caps.height)}`;

  console.log(`\n  transport      ${caps.transport}`);
  console.log(`  codec          ${caps.codec ?? '(unknown)'}`);
  console.log(`  resolution     ${resolution}`);
  console.log(
    `  measured fps   ${caps.measuredFps === null ? '(unknown)' : String(caps.measuredFps)}`,
  );
  console.log(
    `  declared fps   ${caps.declaredFps === null ? '(none declared)' : String(caps.declaredFps)}` +
      (caps.declaredFps !== null &&
      caps.measuredFps !== null &&
      caps.declaredFps !== caps.measuredFps
        ? `   <-- MISMATCH: measured ${String(caps.measuredFps)}, header claims ${String(caps.declaredFps)}`
        : ''),
  );
  console.log(
    `  duration       ${caps.durationS === null ? '(live / unbounded)' : `${String(caps.durationS)}s (${(caps.durationS / 3600).toFixed(1)}h)`}`,
  );
  console.log(`  seekable       ${String(caps.seekable)}`);
  console.log(`  encrypted      ${String(caps.encrypted)}`);
  console.log(`  probe took     ${String(caps.probeMs)}ms`);

  if (args.seek !== undefined && args.kind === 'hls') {
    if (!caps.seekable) {
      console.log(`\n  seek requested but this stream is not seekable — skipping`);
    } else {
      await mkdir(args.outDir, { recursive: true });
      const outPath = path.join(args.outDir, `${args.camera}_seek${String(args.seek)}.jpg`);
      // Built directly rather than pulled from the registry: `extractFrame` is HLS-specific and
      // deliberately not on the shared interface — a seek-to-JPEG makes no sense for a live
      // transport, and widening the interface to fit one adapter is how abstractions rot.
      const hls = createHlsAdapter({ cookie: env.SENTINEL_PORTAL_COOKIE });
      await hls.extractFrame(cfg, args.seek, outPath);
      const brightness = await meanBrightness(outPath);
      const hours = (args.seek / 3600).toFixed(1);

      console.log(`\n  seek to        ${String(args.seek)}s (${hours}h into the recording)`);
      console.log(`  frame written  ${outPath}`);
      console.log(
        `  mean luma      ${brightness === null ? '(unmeasured)' : String(brightness)}` +
          (brightness !== null
            ? brightness > 60
              ? '   <-- DAYLIGHT: the seek genuinely landed past the night section'
              : '   <-- dark frame; the recording is night for ~9 of its 12 hours'
            : ''),
      );
    }
  }
  console.log('');
} catch (error) {
  if (error instanceof AdapterError) {
    // The error *class* is the useful part: AuthError means fix the token, UnreachableError means
    // the camera or the path to it is down. Conflating them sends a technician to a working camera.
    console.error(`\n  ${error.name}: ${error.message}\n`);
  } else {
    console.error(`\n  unexpected: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
