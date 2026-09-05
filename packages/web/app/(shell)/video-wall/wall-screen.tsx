'use client';

/**
 * The video wall.
 *
 * Layout state lives here and nowhere else, and it is **saved to the API, keyed on the user**, not
 * to `localStorage`. A control-room workstation is shared: an officer who signs in on the second
 * shift's console must get their own wall, and `localStorage` would hand them the previous shift's.
 * That is the difference between "persists per browser" and the acceptance criterion's *"persists
 * across reload per user"*.
 *
 * Saves are debounced. Dragging the grid from 2×2 to 4×4 to 3×3 while deciding is three states an
 * operator passed through, not three walls they chose, and writing each one is three round trips for
 * a decision that is not made yet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  activeCameraIds,
  assign,
  gridDimensions,
  layoutsEqual,
  type WallGrid,
  type WallLayout,
} from '@/src/lib/wall/layout';
import { CameraTile } from './camera-tile';
import { CameraPicker } from './camera-picker';
import { WallToolbar } from './wall-toolbar';
import { SingleCameraView, type GatewaySelfTest } from './single-camera';
import { loadManifest, saveLayout } from './actions';
import type { RelayStats, StreamManifest, WallCamera } from './types';

const SAVE_DEBOUNCE_MS = 800;
const RELAY_POLL_MS = 5000;

const GRID_CLASS: Record<WallGrid, string> = {
  '2x2': 'grid-cols-1 sm:grid-cols-2',
  '3x3': 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3',
  '4x4': 'grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4',
};

export function WallScreen({
  cameras,
  initialLayout,
  selfTest,
  initialCameraId,
}: {
  cameras: readonly WallCamera[];
  initialLayout: WallLayout;
  selfTest: GatewaySelfTest;
  /** From `?camera=<uuid>` — how the registry drawer's live-preview button lands here. */
  initialCameraId: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [layout, setLayout] = useState<WallLayout>(initialLayout);
  const [picking, setPicking] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [single, setSingle] = useState<string | null>(initialCameraId);
  const [singleManifest, setSingleManifest] = useState<StreamManifest | null>(null);
  const [relay, setRelay] = useState<RelayStats | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const saved = useRef<WallLayout>(initialLayout);

  const byId = useMemo(() => new Map(cameras.map((camera) => [camera.id, camera])), [cameras]);
  const { rows, columns } = gridDimensions(layout.grid);

  // ── Persist, debounced ───────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (layoutsEqual(layout, saved.current)) return;
    setSaving(true);
    const id = window.setTimeout(() => {
      void saveLayout(layout).then((ok) => {
        saved.current = layout;
        setSaving(false);
        setSaveFailed(!ok);
      });
    }, SAVE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [layout]);

  // ── What the relay is costing the gateway ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch('/video-wall/stream/relay/stats', { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        setRelay((await response.json()) as RelayStats);
      } catch {
        // A stats poll that fails must never disturb playback.
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), RELAY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // ── The single-camera view's manifest ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setSingleManifest(null);
    if (single === null) return;
    void loadManifest(single).then((result) => {
      if (!cancelled) setSingleManifest(result);
    });
    return () => {
      cancelled = true;
    };
  }, [single]);

  /**
   * Keep `?camera=` in the URL.
   *
   * D1-08's drawer is addressable — `/registry?camera=<uuid>` opens on that camera — and its
   * handoff asks that whatever D3-07 opens keeps that property. A shared link to one camera has to
   * survive being pasted into a message, which is how a control room actually works.
   */
  const openSingle = useCallback(
    (cameraId: string | null) => {
      setSingle(cameraId);
      const params = new URLSearchParams(searchParams.toString());
      if (cameraId === null) params.delete('camera');
      else params.set('camera', cameraId);
      const query = params.toString();
      router.replace(query === '' ? '/video-wall' : `/video-wall?${query}`, { scroll: false });
    },
    [router, searchParams],
  );

  const singleCamera = single === null ? null : (byId.get(single) ?? null);

  if (singleCamera !== null) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold text-slate-100">Video wall</h1>
        <SingleCameraView
          camera={singleCamera}
          manifest={singleManifest}
          overlay={layout.overlay}
          selfTest={selfTest}
          onClose={() => {
            openSingle(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Video wall</h1>
          <p className="mt-1 text-xs text-slate-500">
            {activeCameraIds(layout).length} of {String(rows * columns)} slots filled ·{' '}
            <span title="Only the tiles you can see hold a connection. Scrolling one out of view closes it.">
              connections open only for visible tiles
            </span>
          </p>
        </div>
        <WallToolbar
          grid={layout.grid}
          overlay={layout.overlay}
          saving={saving}
          saveFailed={saveFailed}
          relay={relay}
          onGrid={(grid) => {
            setLayout((current) => ({
              ...current,
              grid,
              slots: Array.from(
                { length: gridDimensions(grid).rows * gridDimensions(grid).columns },
                (_, index) => current.slots[index] ?? null,
              ),
            }));
          }}
          onOverlay={(overlay) => {
            setLayout((current) => ({ ...current, overlay }));
          }}
        />
      </div>

      <div
        data-testid="wall-grid"
        data-grid={layout.grid}
        className={`grid gap-3 ${GRID_CLASS[layout.grid]}`}
      >
        {layout.slots.map((cameraId, index) => (
          <CameraTile
            key={`${String(index)}:${cameraId ?? 'empty'}`}
            slot={index}
            camera={cameraId === null ? null : (byId.get(cameraId) ?? null)}
            overlay={layout.overlay}
            selected={selected === index}
            onSelect={setSelected}
            onSwap={setPicking}
            onFullscreen={openSingle}
          />
        ))}
      </div>

      {picking === null ? null : (
        <CameraPicker
          cameras={cameras}
          slot={picking}
          current={layout.slots[picking] ?? null}
          onPick={(cameraId) => {
            setLayout((current) => assign(current, picking, cameraId));
            setPicking(null);
          }}
          onClose={() => {
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
