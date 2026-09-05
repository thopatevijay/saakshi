'use client';

/**
 * The preservation request form.
 *
 * The paragraph above the button is the most important thing on this screen and is not decoration:
 * it is `PRESERVATION_DISCLAIMER` from `@saakshi/shared`, imported rather than paraphrased, and it
 * says that pressing this button does **not** stop anybody's recorder overwriting anything. SAAKSHI
 * has no connection to any department's storage. What the button does is create an auditable
 * instruction with a case reference attached — which is worth a great deal, and is not the same
 * thing at all.
 */
import { useActionState } from 'react';
import { PRESERVATION_DISCLAIMER } from '@saakshi/shared';
import { requestPreservation } from './actions';
import type { CameraRetention, PreservationFormState } from './types';

const FIELD =
  'h-9 rounded-md border border-slate-700 bg-slate-900 px-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400';
const LABEL = 'text-[11px] font-semibold tracking-wide text-slate-400 uppercase';

const INITIAL: PreservationFormState = { ok: false, message: null, auditHash: null };

export function PreservationForm({
  cameras,
  canRequest,
  defaultWindowStart,
  defaultWindowEnd,
}: {
  cameras: CameraRetention[];
  /** From the shared capability matrix. A courtesy — the API refuses regardless. */
  canRequest: boolean;
  defaultWindowStart: string;
  defaultWindowEnd: string;
}) {
  const [state, action, pending] = useActionState(requestPreservation, INITIAL);

  return (
    <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="text-base font-semibold text-slate-100">Request preservation</h2>

      <p
        className="rounded-md border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200"
        data-testid="preservation-disclaimer"
      >
        {PRESERVATION_DISCLAIMER}
      </p>

      {cameras.length === 0 ? (
        <p className="text-sm text-slate-400">
          Run an availability search first — a preservation request names a camera, and there is no
          camera on screen to name.
        </p>
      ) : (
        <form action={action} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Camera</span>
            <select name="cameraId" className={`${FIELD} w-64`} data-testid="preservation-camera">
              {cameras.map((camera) => (
                <option key={camera.cameraId} value={camera.cameraId}>
                  {camera.externalId} · {camera.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Case / FIR</span>
            <input
              name="caseRef"
              required
              placeholder="FIR/2026/00123"
              className={`${FIELD} w-44 font-mono`}
              data-testid="preservation-case"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>From</span>
            <input
              type="datetime-local"
              name="windowStart"
              defaultValue={defaultWindowStart}
              required
              className={`${FIELD} w-56`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>To</span>
            <input
              type="datetime-local"
              name="windowEnd"
              defaultValue={defaultWindowEnd}
              required
              className={`${FIELD} w-56`}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className={LABEL}>Why this footage is needed</span>
            <input
              name="purpose"
              required
              minLength={3}
              placeholder="Snatching at Paldi Circle — hold the approach footage"
              className={`${FIELD} w-full min-w-64`}
              data-testid="preservation-purpose"
            />
          </label>
          <button
            type="submit"
            disabled={!canRequest || pending}
            className="h-9 rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-medium text-slate-100 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            data-action="preservation-submit"
          >
            {pending ? 'Recording…' : 'Record request'}
          </button>
        </form>
      )}

      {canRequest ? null : (
        <p className="text-xs text-slate-500">
          Your role can read the queue but not add to it. A supervisor or an administrator raises the
          request.
        </p>
      )}

      {state.message === null ? null : (
        <p
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${
            state.ok
              ? 'border-emerald-900/60 bg-emerald-950/20 text-emerald-200'
              : 'border-rose-900/60 bg-rose-950/30 text-rose-200'
          }`}
          data-testid="preservation-result"
        >
          {state.message}
          {state.auditHash === null ? null : (
            <>
              {' '}
              <span className="font-mono text-xs opacity-70">
                chain entry {state.auditHash.slice(0, 12)}…
              </span>
            </>
          )}
        </p>
      )}
    </section>
  );
}
