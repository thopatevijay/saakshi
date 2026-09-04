'use client';

import { useToast, ConfirmButton } from '@/src/components/toast';
import type { CameraListResponse } from '@/src/lib/api/client';

type Camera = CameraListResponse['data'][number];

const BAND_CLASS: Record<string, string> = {
  trusted: 'bg-emerald-950/60 text-emerald-300 border-emerald-900',
  degraded: 'bg-amber-950/60 text-amber-300 border-amber-900',
  untrusted: 'bg-rose-950/60 text-rose-300 border-rose-900',
  unscored: 'bg-slate-800/60 text-slate-400 border-slate-700',
};

/**
 * Trust band from the score.
 *
 * **D1-06's handoff warns that this is not the whole story:** `dead` is resolved from the latest
 * health check, not the stored number, because an unreachable camera keeps its last good score.
 * D1-08 must take the band from the trust API. This stub renders the score it has and deliberately
 * does not claim to show `dead`.
 */
function band(score: number | null): keyof typeof BAND_CLASS {
  if (score === null) return 'unscored';
  if (score >= 70) return 'trusted';
  if (score >= 40) return 'degraded';
  return 'untrusted';
}

export function RegistryTable({
  cameras,
  canWrite,
  canDelete,
}: {
  cameras: Camera[];
  canWrite: boolean;
  canDelete: boolean;
}) {
  const { notify } = useToast();

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Cameras in the registry with their measured trust score
        </caption>
        <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              Camera
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              District
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Adapter
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Trust
            </th>
            {canWrite || canDelete ? (
              <th scope="col" className="px-4 py-3 font-medium">
                Actions
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {cameras.map((camera) => {
            const score = camera.trustScore;
            const tone = band(score);
            return (
              <tr key={camera.id} className="hover:bg-slate-900/40">
                <td className="px-4 py-3">
                  <span className="block font-medium text-slate-200">{camera.externalId}</span>
                  <span className="block text-xs text-slate-400">{camera.name}</span>
                </td>
                <td className="px-4 py-3 text-slate-400">{camera.district ?? '—'}</td>
                <td className="px-4 py-3 text-slate-400">{camera.adapterKind}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${BAND_CLASS[tone]}`}
                  >
                    {score === null ? 'unscored' : `${String(score)} · ${tone}`}
                  </span>
                </td>
                {canWrite || canDelete ? (
                  <td className="px-4 py-3">
                    <span className="flex gap-2">
                      {canWrite ? (
                        <button
                          type="button"
                          onClick={() => {
                            notify(
                              `Editing ${camera.externalId} lands with the full registry screen.`,
                              'info',
                            );
                          }}
                          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                        >
                          Edit
                        </button>
                      ) : null}
                      {canDelete ? (
                        <ConfirmButton
                          label="Decommission"
                          confirmLabel="Yes, decommission"
                          question={`Decommission ${camera.externalId}?`}
                          destructive
                          onConfirm={() => {
                            // Soft delete only — the row stays as provenance for every sighting
                            // already attached to it. Wired up with the full screen in D1-08.
                            notify(`${camera.externalId} would be soft-deleted.`, 'success');
                          }}
                        />
                      ) : null}
                    </span>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
