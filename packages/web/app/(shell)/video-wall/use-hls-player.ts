'use client';

/**
 * One `hls.js` player, attached only while its tile is on screen and torn down the moment it is not.
 *
 * ## The two acceptance criteria this hook *is*
 *
 * *"Only visible tiles hold connections"* and *"unmounting a tile closes its connection (no leaked
 * streams)"*. Both are the same rule from the organisers' Integrator's Guide, which asks clients to
 * pace their load because **each connected client gets its own copy of the stream** — so a wall that
 * kept nine players alive behind a tab, or leaked one per layout change, would multiply the load on
 * a department's gateway for video nobody is looking at.
 *
 * Teardown is deliberately four steps, not one. `hls.destroy()` alone is not enough:
 *
 *   1. `hls.destroy()`            — stops the loaders and detaches the `MediaSource`
 *   2. `video.removeAttribute('src')` — a `src` left set keeps the resource loaded
 *   3. `video.load()`             — makes the element release it *now* rather than at GC
 *   4. `video.srcObject = null`   — the Safari-native path, which never used `hls.js` at all
 *
 * Skipping (2) and (3) leaves the element holding a decoded buffer that shows up as flat-looking
 * heap while native memory climbs — the exact shape AC 8 ("no monotonic growth") is watching for.
 *
 * ## Muted
 *
 * AC 1 says "without audio", and every tile is `muted`. That is also what makes autoplay possible
 * at all: a muted video may start on its own, an unmuted one may not — nine tiles each waiting for
 * a click would not be a video wall.
 *
 * When a stream carries a *separate* audio rendition, `MANIFEST_PARSED` deselects it, so nine tiles
 * never start nine audio decoders. When the audio is muxed into the MPEG-TS segments — as it is on
 * the sandbox — there is nothing to deselect and `muted` is the whole of it. Saying so plainly is
 * better than a config flag that reads as if it did more than it does.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { rollingDeliveryRate, type FragmentTiming } from '@/src/lib/wall/delivery';
import { playerClosed, playerOpened, playerUpdated, requestCounted } from '@/src/lib/wall/debug';

/** How many fragments the rolling delivery rate is computed over. */
const RATE_WINDOW = 6;

export interface HlsPlayerState {
  attached: boolean;
  readyState: number;
  deliveryRate: number | null;
  fragments: number;
  cacheHits: number;
  error: string | null;
}

const INITIAL: HlsPlayerState = {
  attached: false,
  readyState: 0,
  deliveryRate: null,
  fragments: 0,
  cacheHits: 0,
  error: null,
};

export function useHlsPlayer(options: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  cameraId: string | null;
  externalId: string;
  slot: number;
  /** The playlist URL, or null when this camera has no resolvable stream. */
  playlistUrl: string | null;
  /** False for a dead camera — no socket is opened at all. */
  enabled: boolean;
}): HlsPlayerState {
  const { videoRef, cameraId, externalId, slot, playlistUrl, enabled } = options;
  const [state, setState] = useState<HlsPlayerState>(INITIAL);
  const timings = useRef<FragmentTiming[]>([]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || cameraId === null || playlistUrl === null || !enabled) {
      setState(INITIAL);
      return;
    }

    let hls: Hls | null = null;
    let cancelled = false;
    timings.current = [];

    const open = async (): Promise<void> => {
      // Dynamic import: `hls.js` is ~200 kB and no other screen needs it, so it must not sit in the
      // shared bundle that the registry map and the alert queue pay for.
      const { default: HlsCtor } = await import('hls.js');
      if (cancelled) return;

      if (!HlsCtor.isSupported()) {
        // Safari plays HLS natively and needs no library. Both paths are torn down identically.
        video.src = playlistUrl;
        playerOpened({
          cameraId,
          externalId,
          slot,
          transport: 'hls',
          readyState: video.readyState,
          currentTime: 0,
          deliveryRate: null,
          fragments: 0,
          cacheHits: 0,
          error: null,
        });
        setState((s) => ({ ...s, attached: true }));
        return;
      }

      hls = new HlsCtor({
        // The upstream was measured at 0.12x-0.28x real time, so a short buffer guarantees a stall.
        // 60 s of forward buffer lets the relay's read-ahead get far enough in front to matter.
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        // A VOD playlist of 7,200 segments does not need re-fetching; the relay caches it anyway.
        manifestLoadingMaxRetry: 2,
        fragLoadingMaxRetry: 4,
        // Nine tiles must not each open six parallel loaders at a gateway already throttling.
        // hls.js has no global cap, so the per-player ceiling is the only lever there is.
        maxLoadingDelay: 8,
        enableWorker: true,
        lowLatencyMode: false,
      });

      hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
        // Alternate audio renditions are deselected outright — see the module note. `-1` is
        // hls.js's "no track"; on a muxed stream there are no tracks and this is a no-op.
        if (hls !== null && hls.audioTracks.length > 0) hls.audioTrack = -1;
      });

      hls.on(HlsCtor.Events.FRAG_LOADED, (_event, data) => {
        requestCounted(cameraId);
        const loadMs = data.frag.stats.loading.end - data.frag.stats.loading.start;
        timings.current = [...timings.current, { durationS: data.frag.duration, loadMs }].slice(
          -RATE_WINDOW,
        );
        const rate = rollingDeliveryRate(timings.current);
        // A fragment that arrived faster than the network could possibly have delivered it came
        // from the relay's cache. Counting them separately keeps the delivery rate honest: a wall
        // replaying cached segments is not evidence the gateway got faster.
        const cached = loadMs < 50;
        setState((s) => ({
          ...s,
          fragments: s.fragments + 1,
          cacheHits: s.cacheHits + (cached ? 1 : 0),
          deliveryRate: rate,
        }));
        playerUpdated(cameraId, { fragments: timings.current.length, deliveryRate: rate });
      });

      hls.on(HlsCtor.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        // Fatal is not always terminal: hls.js's own guidance is to try one recovery per class
        // before giving up, and a throttled gateway produces spurious network fatals.
        if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) {
          hls?.startLoad();
          setState((s) => ({ ...s, error: `network: ${data.details}` }));
          return;
        }
        if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) {
          hls?.recoverMediaError();
          setState((s) => ({ ...s, error: `media: ${data.details}` }));
          return;
        }
        setState((s) => ({ ...s, error: data.details }));
        playerUpdated(cameraId, { error: data.details });
      });

      hls.attachMedia(video);
      hls.loadSource(playlistUrl);

      playerOpened({
        cameraId,
        externalId,
        slot,
        transport: 'hls',
        readyState: video.readyState,
        currentTime: 0,
        deliveryRate: null,
        fragments: 0,
        cacheHits: 0,
        error: null,
      });
      setState((s) => ({ ...s, attached: true }));
    };

    void open();

    return () => {
      cancelled = true;
      if (hls !== null) {
        hls.destroy();
        hls = null;
      }
      // See the module note: destroy() alone leaves the element holding the media.
      video.removeAttribute('src');
      video.srcObject = null;
      video.load();
      playerClosed(cameraId);
      setState(INITIAL);
    };
  }, [videoRef, cameraId, externalId, slot, playlistUrl, enabled]);

  // `readyState` and `currentTime` are not React state on the element, so they are polled — once a
  // second, which is fast enough for a badge and slow enough to be invisible in a memory profile.
  useEffect(() => {
    if (cameraId === null) return;
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (video === null) return;
      setState((s) => (s.readyState === video.readyState ? s : { ...s, readyState: video.readyState }));
      playerUpdated(cameraId, {
        readyState: video.readyState,
        currentTime: video.currentTime,
      });
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [videoRef, cameraId]);

  return state;
}

/** Play, swallowing the autoplay rejection a muted video should never produce but sometimes does. */
export function usePlayWhenReady(videoRef: React.RefObject<HTMLVideoElement | null>): () => void {
  return useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;
    void video.play().catch(() => undefined);
  }, [videoRef]);
}
