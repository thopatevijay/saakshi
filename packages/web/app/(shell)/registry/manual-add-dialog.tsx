'use client';

/**
 * Onboarding path 2 — one camera, by hand.
 *
 * The path a department uses for a single new installation, and the one that fixes the estate's
 * biggest gap: **a camera with no coordinates cannot be placed on the map or used to reconstruct a
 * route**, and the upstream catalogue supplies none. So latitude and longitude are near the top of
 * this form rather than buried under advanced options, with the reason stated.
 *
 * Declared codec, fps and resolution are accepted **as given and never trusted** — the declared vs
 * measured delta is Pillar 1's whole argument, so a wrong declaration is data, not a validation
 * error.
 */
import { useActionState } from 'react';
import { addCamera } from './actions';
import type { ManualAddState } from './types';
import {
  ADAPTER_KINDS,
  CAMERA_MOUNTS,
  CAMERA_TYPES,
  GEOMETRY_CLASSES,
} from '@/src/lib/registry/query';

const INITIAL: ManualAddState = { created: null, error: null };

const INPUT =
  'w-full rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-400';

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint === undefined ? null : <span className="block text-[11px] text-slate-600">{hint}</span>}
    </label>
  );
}

export function ManualAddDialog({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(addCamera, INITIAL);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="manual-add-heading"
      data-testid="manual-add-dialog"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/70 px-4 py-10 backdrop-blur-sm"
    >
      <div className="w-full max-w-xl rounded-lg border border-slate-800 bg-slate-950 shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-4">
          <div>
            <h2 id="manual-add-heading" className="text-sm font-semibold text-slate-100">
              Add a camera
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              For a single new installation. Declared values are recorded as declared and measured
              separately — the difference is the point.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            Close
          </button>
        </header>

        <form action={formAction} className="grid grid-cols-2 gap-x-4 gap-y-3 px-6 py-5">
          <Row label="Camera id *">
            <input name="externalId" required className={INPUT} placeholder="GJ-AHM-042" />
          </Row>
          <Row label="Name *">
            <input name="name" required className={INPUT} placeholder="Ashram Road junction" />
          </Row>

          <Row label="Latitude" hint="Without coordinates the camera cannot be mapped.">
            <input name="lat" type="number" step="any" className={INPUT} placeholder="23.0225" />
          </Row>
          <Row label="Longitude">
            <input name="lon" type="number" step="any" className={INPUT} placeholder="72.5714" />
          </Row>

          <Row label="District">
            <input name="district" className={INPUT} placeholder="Ahmedabad" />
          </Row>
          <Row label="Address">
            <input name="address" className={INPUT} />
          </Row>

          <Row label="Adapter">
            <select name="adapterKind" defaultValue="hls" className={INPUT}>
              {ADAPTER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Endpoint">
            <input name="endpoint" className={INPUT} placeholder="https://…/stream.m3u8" />
          </Row>

          <Row label="Camera type">
            <select name="cameraType" defaultValue="ip" className={INPUT}>
              {CAMERA_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Mount">
            <select name="mount" defaultValue="static" className={INPUT}>
              {CAMERA_MOUNTS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Geometry class" hint="Whether the angle can support plate reading at all.">
            <select name="geometryClass" defaultValue="unclassified" className={INPUT}>
              {GEOMETRY_CLASSES.map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Retention (days)">
            <input name="retentionDays" type="number" min={0} max={3650} className={INPUT} />
          </Row>

          <Row label="Declared resolution" hint="Recorded, never trusted.">
            <input name="declaredResolution" className={INPUT} placeholder="1920x1080" />
          </Row>
          <Row label="Declared fps">
            <input name="declaredFps" type="number" step="any" className={INPUT} placeholder="25" />
          </Row>

          <div className="col-span-2 flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-sky-700 px-4 py-2 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            >
              {pending ? 'Adding…' : 'Add camera'}
            </button>
            {state.error === null ? null : (
              <p role="alert" className="text-xs text-rose-300">
                {state.error}
              </p>
            )}
            {state.created === null ? null : (
              <p role="status" className="text-xs text-emerald-300">
                {state.created.externalId} added. It has no trust score until a probe runs.
              </p>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
