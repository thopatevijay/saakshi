'use client';

/**
 * One tile.
 *
 * Everything a control-room operator needs to decide whether to believe what they are looking at,
 * and nothing they do not: the camera's name and department, the trust band **as the API resolved
 * it**, whether frames are arriving, and — when they are not — the measured reason why.
 *
 * ## The tile never spins
 *
 * *"Graceful degradation: a dead camera shows its trust reason, not a spinner forever."* A spinner
 * is a promise that something is about to happen. On a camera whose last probe could not connect,
 * that promise is false, and the false version of it is the exact failure PROJECT.md's P2 names:
 * *"a dead camera is worse than no camera — it creates false assurance."* So a dead tile opens no
 * socket at all and states what the prober found.
 *
 * The same applies while the stream is merely slow. The gateway was measured delivering a 6 s
 * segment in 21.8–48.7 s, and a tile that showed a spinner through that would be blamed on the
 * console. Instead the badge reads the delivery rate, and the tooltip says whose problem it is.
 *
 * ## Only mounted when visible
 *
 * The `<video>` and its player exist only while the tile intersects the viewport. `useHlsPlayer`'s
 * cleanup is what closes the connection; this component decides *when*.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BAND_STYLE, bandKeyOf } from '@/src/lib/registry/trust';
import { presentTrust } from '@/src/lib/wall/trust-reason';
import { deliveryReason, deliveryVerdict } from '@/src/lib/wall/delivery';
import { DetectionOverlay } from './detection-overlay';
import { useHlsPlayer, usePlayWhenReady } from './use-hls-player';
import { loadManifest } from './actions';
import type { StreamManifest, WallCamera } from './types';

const VERDICT_CHIP: Record<string, string> = {
  realtime: 'border-emerald-800 bg-emerald-950/70 text-emerald-300',
  marginal: 'border-amber-800 bg-amber-950/70 text-amber-300',
  throttled: 'border-rose-800 bg-rose-950/70 text-rose-300',
  unknown: 'border-slate-700 bg-slate-900/70 text-slate-400',
};

export function CameraTile({
  slot,
  camera,
  overlay,
  selected,
  onSelect,
  onSwap,
  onFullscreen,
}: {
  slot: number;
  camera: WallCamera | null;
  overlay: boolean;
  selected: boolean;
  onSelect: (slot: number) => void;
  onSwap: (slot: number) => void;
  onFullscreen: (cameraId: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [manifest, setManifest] = useState<StreamManifest | null>(null);
  const [detections, setDetections] = useState(0);
  const play = usePlayWhenReady(videoRef);

  // ── Visibility gates the connection ──────────────────────────────────────────────────────────
  useEffect(() => {
    const node = rootRef.current;
    if (node === null) return;
    // `rootMargin` deliberately 0: a tile scrolled just out of view must *stop*, not stay warm.
    // Pre-warming would quietly reintroduce the load this criterion exists to remove.
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry !== undefined) setVisible(entry.isIntersecting);
      },
      { threshold: 0.01 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  // ── The manifest decides whether to open anything ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setManifest(null);
    if (camera === null || !visible) return;
    void loadManifest(camera.id).then((result) => {
      if (!cancelled) setManifest(result);
    });
    return () => {
      cancelled = true;
    };
  }, [camera, visible]);

  const trust =
    manifest === null
      ? null
      : presentTrust({
          band: manifest.trust.band,
          score: manifest.trust.score,
          checkedAt: manifest.trust.checkedAt,
          connectable: manifest.trust.connectable,
          decodable: manifest.trust.decodable,
          error: manifest.trust.error,
          measuredFps: manifest.trust.measuredFps,
          actualResolution: manifest.trust.actualResolution,
          failingSignals: manifest.trust.failingSignals,
        });

  const playable = trust?.playable === true && manifest?.hls !== null && manifest !== null;
  const playlistUrl =
    camera !== null && playable ? `/video-wall/stream/${camera.id}/index.m3u8` : null;

  const player = useHlsPlayer({
    videoRef,
    cameraId: camera?.id ?? null,
    externalId: camera?.externalId ?? '',
    slot,
    playlistUrl,
    enabled: visible && playable,
  });

  const onStatus = useCallback((status: { count: number }) => {
    setDetections((current) => (current === status.count ? current : status.count));
  }, []);

  const band = BAND_STYLE[bandKeyOf(camera?.band ?? null)];
  const verdict = deliveryVerdict(player.deliveryRate);

  if (camera === null) {
    return (
      <button
        type="button"
        data-testid="wall-tile"
        data-slot={String(slot)}
        data-empty="true"
        onClick={() => {
          onSwap(slot);
        }}
        className="flex aspect-video min-h-0 w-full items-center justify-center rounded-lg border border-dashed border-slate-800 bg-slate-950/40 text-xs text-slate-500 hover:border-sky-800 hover:text-slate-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      >
        Empty slot {slot + 1} · choose a camera
      </button>
    );
  }

  return (
    <div
      ref={rootRef}
      data-testid="wall-tile"
      data-slot={String(slot)}
      data-camera={camera.id}
      data-external-id={camera.externalId}
      data-tile-band={bandKeyOf(camera.band)}
      data-visible={String(visible)}
      data-attached={String(player.attached)}
      data-ready-state={String(player.readyState)}
      data-delivery={verdict}
      className={`relative flex aspect-video min-h-0 w-full flex-col overflow-hidden rounded-lg border bg-black ${
        selected ? 'border-sky-500 ring-1 ring-sky-500/40' : 'border-slate-800'
      }`}
      onClick={() => {
        onSelect(slot);
      }}
    >
      {/* ── The picture ───────────────────────────────────────────────────────────────────────── */}
      {playable ? (
        <video
          ref={videoRef}
          // `muted` is required for autoplay and is AC 1's "without audio" at the element level;
          // `hls.js` is additionally told never to select an audio track. `playsInline` keeps iOS
          // from hijacking the tile into a fullscreen player.
          muted
          autoPlay
          playsInline
          preload="none"
          onLoadedMetadata={play}
          data-testid="wall-video"
          className="absolute inset-0 size-full object-contain"
        />
      ) : null}

      {/* Mounted whenever there is a picture to draw on; `enabled` decides whether it draws. */}
      {playable && manifest !== null ? (
        <DetectionOverlay
          videoRef={videoRef}
          cameraId={camera.id}
          measuredResolution={manifest.trust.actualResolution}
          enabled={overlay}
          onStatus={onStatus}
        />
      ) : null}

      {/* ── Not playing: the reason, never a spinner ───────────────────────────────────────────── */}
      {!playable ? (
        <div
          data-testid="wall-tile-reason"
          className="absolute inset-0 flex flex-col justify-center gap-1.5 px-4 py-3 text-left"
        >
          {manifest === null && visible ? (
            <p className="text-xs text-slate-500">Checking this camera…</p>
          ) : manifest === null ? (
            <p className="text-xs text-slate-600">Off screen — no connection open.</p>
          ) : (
            <>
              <p className="text-xs font-medium text-slate-200">{trust?.headline}</p>
              {trust?.detail === null || trust?.detail === undefined ? null : (
                <p className="text-[11px] leading-relaxed text-slate-400">{trust.detail}</p>
              )}
              {manifest.hls === null ? (
                <p className="text-[11px] leading-relaxed text-amber-400">
                  No stream URL resolves for this camera. `GET /api/ingest` is the contract and the
                  registry row carries no endpoint — this is configuration, not a fault.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* ── Chrome: identity, trust, liveness ──────────────────────────────────────────────────── */}
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/80 to-transparent px-2.5 py-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-slate-100">{camera.name}</p>
          <p className="truncate text-[10px] text-slate-400">
            {camera.externalId}
            {camera.departmentCode === null ? '' : ` · ${camera.departmentCode}`}
            {camera.district === null ? '' : ` · ${camera.district}`}
          </p>
        </div>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${band.chip}`}
          title={trust?.headline ?? band.meaning}
          data-testid="wall-tile-band"
        >
          {band.label}
        </span>
      </header>

      <footer className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent px-2.5 py-1.5">
        <div className="flex items-center gap-1.5">
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] tabular-nums ${VERDICT_CHIP[verdict] ?? ''}`}
            title={deliveryReason(player.deliveryRate, verdict)}
            data-testid="wall-tile-delivery"
          >
            {player.deliveryRate === null ? 'measuring' : `${player.deliveryRate.toFixed(2)}×`}
          </span>
          {overlay && playable ? (
            <span className="rounded border border-slate-700 bg-slate-900/70 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-300">
              {detections} det
            </span>
          ) : null}
          {manifest !== null && manifest.sightings.total > 0 ? (
            <span
              className="rounded border border-slate-700 bg-slate-900/70 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-400"
              title="Sightings recorded against this camera by the analytics worker."
            >
              {manifest.sightings.total.toLocaleString()} sightings
            </span>
          ) : null}
        </div>
        <div className="pointer-events-auto flex items-center gap-1">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSwap(slot);
            }}
            className="rounded border border-slate-700 bg-slate-900/80 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            title="Put a different camera in this slot"
          >
            Swap
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onFullscreen(camera.id);
            }}
            className="rounded border border-slate-700 bg-slate-900/80 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            title="Open this camera on its own, with the low-latency option"
          >
            Open
          </button>
        </div>
      </footer>
    </div>
  );
}
