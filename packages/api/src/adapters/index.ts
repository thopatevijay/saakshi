import type { Env } from '../env.js';
import { createHlsAdapter } from './hls.js';
import { createRtspAdapter } from './rtsp.js';
import { createOnvifAdapter } from './onvif.js';
import { createWhepAdapter } from './whep.js';
import { createFileAdapter, createNvrAdapter } from './nvr-file.js';
import { NotImplementedError, type AdapterKind, type CameraAdapter } from './types.js';

export * from './types.js';
export { backoffDelayMs, backoffSequenceMs, withBackoff } from './backoff.js';
export {
  BROWSER_UA,
  httpInputArgs,
  isHttpUrl,
  measuredFpsFrom,
  classifyFfmpegError,
  parseDecodedSeconds,
  probeArgs,
  streamArgs,
  extractFrameArgs,
} from './ffmpeg.js';
export { createHlsAdapter } from './hls.js';
export { createRtspAdapter } from './rtsp.js';
export { createOnvifAdapter } from './onvif.js';
export { createWhepAdapter } from './whep.js';
export { createFileAdapter, createNvrAdapter } from './nvr-file.js';

/**
 * The adapter registry.
 *
 * **This map is the Model 4 claim, and it is deliberately this boring.** Adding a department's
 * vendor means writing one file and adding one line here — nothing else in the codebase learns
 * about the new transport, because nothing outside `adapters/` branches on `kind`. The
 * "sixth adapter" test in `adapters.test.ts` registers a throwaway adapter and drives it through
 * the same code path, so the claim is checkable rather than asserted.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<AdapterKind | string, CameraAdapter>();

  register(adapter: CameraAdapter): this {
    this.adapters.set(adapter.kind, adapter);
    return this;
  }

  /** Throws rather than returning undefined: a camera whose transport is unknown is a data error. */
  get(kind: AdapterKind | string): CameraAdapter {
    const adapter = this.adapters.get(kind);
    if (adapter === undefined) {
      throw new NotImplementedError(
        `no adapter registered for transport '${kind}' — registered: ${this.kinds().join(', ')}`,
        '(unknown)',
        'nvr',
      );
    }
    return adapter;
  }

  has(kind: AdapterKind | string): boolean {
    return this.adapters.has(kind);
  }

  kinds(): string[] {
    return [...this.adapters.keys()].map(String);
  }

  all(): CameraAdapter[] {
    return [...this.adapters.values()];
  }

  /**
   * The honesty table, derived from the code rather than maintained beside it.
   *
   * `docs/adapter-framework.md` and D4-05's HLD both quote this. Generating it from
   * `adapter.status` means the documentation cannot drift into claiming a transport works against
   * the government feed when it does not — the single most damaging claim we could make.
   */
  transportTable(): { kind: string; status: string; description: string }[] {
    return this.all().map((a) => ({
      kind: a.kind,
      status: a.status,
      description: a.description,
    }));
  }
}

/**
 * The production registry.
 *
 * All six transports the `adapter_kind` enum allows. `hls` and `file` are operational; `rtsp`,
 * `onvif` and `whep` are demonstrated against local MediaMTX and **not** against the sandbox,
 * which serves no such transport; `nvr` is a stub that says so.
 */
export function createAdapterRegistry(env: Pick<Env, 'SENTINEL_PORTAL_COOKIE'>): AdapterRegistry {
  return new AdapterRegistry()
    .register(createHlsAdapter({ cookie: env.SENTINEL_PORTAL_COOKIE }))
    .register(createRtspAdapter())
    .register(createOnvifAdapter())
    .register(createWhepAdapter())
    .register(createFileAdapter())
    .register(createNvrAdapter());
}
