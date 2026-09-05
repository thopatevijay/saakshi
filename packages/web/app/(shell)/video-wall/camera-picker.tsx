'use client';

/**
 * Choosing which camera goes in a slot.
 *
 * The band is shown against every option, taken from `CameraResponse.band` and coloured from
 * `src/lib/registry/trust.ts` — so an operator building a wall can see, while they are building it,
 * which of these cameras have never been probed. That is the point of the registry: a wall of nine
 * cameras nobody has measured looks exactly like a wall of nine good ones until it is needed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BAND_STYLE, bandKeyOf } from '@/src/lib/registry/trust';
import type { WallCamera } from './types';

export function CameraPicker({
  cameras,
  slot,
  current,
  onPick,
  onClose,
}: {
  cameras: readonly WallCamera[];
  slot: number;
  current: string | null;
  onPick: (cameraId: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows =
      needle === ''
        ? cameras
        : cameras.filter(
            (camera) =>
              camera.externalId.toLowerCase().includes(needle) ||
              camera.name.toLowerCase().includes(needle) ||
              (camera.district ?? '').toLowerCase().includes(needle) ||
              (camera.departmentCode ?? '').toLowerCase().includes(needle),
          );
    return rows.slice(0, 200);
  }, [cameras, query]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Choose a camera for slot ${String(slot + 1)}`}
      data-testid="camera-picker"
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-950 shadow-2xl"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">Slot {slot + 1}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            Close
          </button>
        </header>

        <div className="border-b border-slate-800 px-4 py-3">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="Filter by id, name, department or district"
            data-testid="camera-picker-search"
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          />
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {current === null ? null : (
            <li>
              <button
                type="button"
                onClick={() => {
                  onPick(null);
                }}
                className="w-full rounded-md px-3 py-2 text-left text-xs text-slate-400 hover:bg-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              >
                Empty this slot
              </button>
            </li>
          )}
          {matches.map((camera) => {
            const band = BAND_STYLE[bandKeyOf(camera.band)];
            return (
              <li key={camera.id}>
                <button
                  type="button"
                  data-testid="camera-picker-option"
                  data-camera={camera.id}
                  onClick={() => {
                    onPick(camera.id);
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${
                    camera.id === current ? 'bg-slate-900' : ''
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-slate-100">{camera.name}</span>
                    <span className="block truncate text-[10px] text-slate-500">
                      {camera.externalId}
                      {camera.departmentCode === null ? '' : ` · ${camera.departmentCode}`}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${band.chip}`}
                    title={band.meaning}
                  >
                    {band.label}
                  </span>
                </button>
              </li>
            );
          })}
          {matches.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-slate-500">
              No camera matches “{query}”.
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
