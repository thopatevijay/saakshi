'use client';

/**
 * One camera, large — and the place the two transports are put side by side.
 *
 * The acceptance criterion is *"WHEP single-camera view plays with visibly lower latency than the
 * HLS tile"*, and "visibly" is the operative word: a latency claim that lives in a PR body is a
 * claim, while two players of **the same source** running next to each other is a demonstration
 * anyone can check in three seconds. `ops/mediamtx/mediamtx.yml` publishes `saakshi-test` as a
 * 640×360 / 25 fps pattern with a **burnt-in timer** for exactly this — the difference between the
 * two clocks on screen *is* the latency difference, readable without instrumentation.
 *
 * A sandbox camera has no WHEP path, and this screen says so in words rather than showing a broken
 * player: the government feed is HLS-only (D1-03), so the WebRTC claim is made about our own edge
 * gateway and about nothing else.
 */
import { useRef, useState } from 'react';
import { BAND_STYLE, bandKeyOf } from '@/src/lib/registry/trust';
import { presentTrust } from '@/src/lib/wall/trust-reason';
import { deliveryReason, deliveryVerdict } from '@/src/lib/wall/delivery';
import { DetectionOverlay } from './detection-overlay';
import { useHlsPlayer, usePlayWhenReady } from './use-hls-player';
import { useWhep } from './whep-player';
import type { StreamManifest, WallCamera } from './types';

export interface GatewaySelfTest {
  path: string;
  hlsUrl: string;
  whepUrl: string;
}

function HlsPane({
  cameraId,
  externalId,
  playlistUrl,
  overlay,
  measuredResolution,
}: {
  cameraId: string;
  externalId: string;
  playlistUrl: string;
  overlay: boolean;
  measuredResolution: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const play = usePlayWhenReady(videoRef);
  const player = useHlsPlayer({
    videoRef,
    cameraId,
    externalId,
    slot: -1,
    playlistUrl,
    enabled: true,
  });
  const verdict = deliveryVerdict(player.deliveryRate);

  return (
    <figure className="relative m-0 aspect-video w-full overflow-hidden rounded-lg border border-slate-800 bg-black">
      <video
        ref={videoRef}
        muted
        autoPlay
        playsInline
        preload="none"
        onLoadedMetadata={play}
        data-testid="single-hls-video"
        className="absolute inset-0 size-full object-contain"
      />
      {/*
        Always mounted, never conditionally rendered. Toggling the overlay off clears the canvas and
        stops the fetch loop — but the element stays, so the transform is not re-initialised on every
        toggle and a verification script has something stable to read pixels from. A canvas that
        appears and disappears is also a layout shift under a playing video.
      */}
      <DetectionOverlay
        videoRef={videoRef}
        cameraId={cameraId}
        measuredResolution={measuredResolution}
        enabled={overlay}
      />
      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/85 to-transparent px-3 py-2 text-[11px]">
        <span className="font-medium text-slate-200">HLS · buffered, segment-based</span>
        <span
          className="tabular-nums text-slate-400"
          title={deliveryReason(player.deliveryRate, verdict)}
        >
          {player.deliveryRate === null ? 'measuring' : `${player.deliveryRate.toFixed(2)}×`} ·{' '}
          {player.fragments} frags
        </span>
      </figcaption>
    </figure>
  );
}

function WhepPane({
  url,
  cameraId,
  externalId,
  label,
}: {
  url: string;
  cameraId: string;
  externalId: string;
  label: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const whep = useWhep({ videoRef, url, cameraId, externalId, enabled: true });

  return (
    <figure className="relative m-0 aspect-video w-full overflow-hidden rounded-lg border border-slate-800 bg-black">
      <video
        ref={videoRef}
        muted
        autoPlay
        playsInline
        data-testid="single-whep-video"
        data-whep-status={whep.status}
        className="absolute inset-0 size-full object-contain"
      />
      {whep.status !== 'connected' ? (
        <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-slate-400">
          {whep.status === 'negotiating'
            ? 'Negotiating WebRTC with the edge gateway…'
            : (whep.error ?? 'Idle')}
        </p>
      ) : null}
      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/85 to-transparent px-3 py-2 text-[11px]">
        <span className="font-medium text-slate-200">{label}</span>
        <span className="tabular-nums text-slate-400">
          {whep.timeToFirstFrameMs === null
            ? whep.status
            : `first frame ${String(whep.timeToFirstFrameMs)} ms`}
        </span>
      </figcaption>
    </figure>
  );
}

export function SingleCameraView({
  camera,
  manifest,
  overlay,
  selfTest,
  onClose,
}: {
  camera: WallCamera;
  manifest: StreamManifest | null;
  overlay: boolean;
  selfTest: GatewaySelfTest;
  onClose: () => void;
}) {
  const [comparing, setComparing] = useState(false);
  const band = BAND_STYLE[bandKeyOf(camera.band)];
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

  return (
    <section data-testid="single-camera" className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-slate-100">{camera.name}</h2>
            <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${band.chip}`}>
              {band.label}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {camera.externalId}
            {camera.departmentCode === null ? '' : ` · ${camera.departmentCode}`}
            {manifest?.trust.actualResolution === null || manifest === null
              ? ''
              : ` · measured ${manifest.trust.actualResolution}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          Back to the wall
        </button>
      </header>

      {trust === null ? null : (
        <p className="rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
          <span className="text-slate-200">{trust.headline}</span>
          {trust.detail === null ? null : <> {trust.detail}</>}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {manifest?.hls === null || manifest === null || trust?.playable !== true ? (
          <div className="flex aspect-video items-center justify-center rounded-lg border border-slate-800 bg-slate-950/60 px-6 text-center text-xs text-slate-400">
            {trust?.headline ?? 'No stream available for this camera.'}
          </div>
        ) : (
          <HlsPane
            cameraId={camera.id}
            externalId={camera.externalId}
            playlistUrl={`/video-wall/stream/${camera.id}/index.m3u8`}
            overlay={overlay}
            measuredResolution={manifest.trust.actualResolution}
          />
        )}

        {manifest?.whep !== null && manifest?.whep !== undefined ? (
          <WhepPane
            url={manifest.whep.url}
            cameraId={`${camera.id}:whep`}
            externalId={camera.externalId}
            label="WHEP · WebRTC, sub-second"
          />
        ) : (
          <div className="flex aspect-video flex-col justify-center gap-3 rounded-lg border border-dashed border-slate-800 bg-slate-950/60 px-6 py-4">
            <h3 className="text-xs font-semibold text-slate-200">No WHEP path for this camera</h3>
            <p className="text-[11px] leading-relaxed text-slate-400">
              {manifest?.whepUnavailable ??
                'The government sandbox serves HLS over HTTPS only. It exposes neither RTSP nor ' +
                  'WHEP, so low-latency WebRTC is demonstrated against our own edge gateway.'}
            </p>
            <button
              type="button"
              data-testid="latency-compare"
              onClick={() => {
                setComparing((value) => !value);
              }}
              className="self-start rounded-md border border-sky-800 bg-sky-950/50 px-3 py-1.5 text-[11px] text-sky-200 hover:bg-sky-900/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            >
              {comparing ? 'Hide' : 'Compare'} HLS vs WHEP on the edge gateway
            </button>
          </div>
        )}
      </div>

      {comparing ? (
        <section
          data-testid="latency-lab"
          className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4"
        >
          <div>
            <h3 className="text-xs font-semibold text-slate-200">
              Edge gateway · the same source through both transports
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
              Both panes below play <code className="text-slate-300">{selfTest.path}</code> from our
              MediaMTX relay — HLS on :8888, WHEP on :8889. The source carries a{' '}
              <span className="text-slate-300">burnt-in timer</span>, so the gap between the two
              clocks is the latency difference, measured rather than asserted. This is our own
              gateway; the government sandbox serves no WebRTC.
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Chrome plays no HLS natively, so the gateway pane goes through `hls.js` too —
                which is also what makes the comparison fair: same player, same machine. */}
            <HlsPane
              cameraId={`gateway:${selfTest.path}:hls`}
              externalId={selfTest.path}
              playlistUrl={selfTest.hlsUrl}
              overlay={false}
              measuredResolution={null}
            />
            <WhepPane
              url={selfTest.whepUrl}
              cameraId={`gateway:${selfTest.path}`}
              externalId={selfTest.path}
              label="WHEP · MediaMTX :8889"
            />
          </div>
        </section>
      ) : null}
    </section>
  );
}
