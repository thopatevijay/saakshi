'use client';

/**
 * The table view.
 *
 * D1-07 shipped this as a stub with a local `band(score)` helper and a comment saying D1-08 must
 * replace it. **This is that replacement.** The band now comes from `camera.band`, resolved by the
 * API from the latest health check, so a camera that went dark yesterday reads `dead` here instead
 * of keeping the green it earned before it stopped answering. Nothing in this file computes a band.
 *
 * Three columns that look similar are deliberately three columns: trust band (what the measurements
 * say), catalogue presence (whether the department still lists it) and health status (what the
 * prober last wrote). D1-04's handoff forbids collapsing presence and health into one badge, and
 * the band is a third fact again.
 */
import { useToast, ConfirmButton } from '@/src/components/toast';
import type { Camera } from './types';
import {
  BAND_STYLE,
  CATALOGUE_STATUS_CHIP,
  HEALTH_STATUS_CHIP,
  bandKeyOf,
} from '@/src/lib/registry/trust';

const CHIP = 'inline-block rounded border px-2 py-0.5 text-xs font-medium';

export function RegistryTable({
  cameras,
  canWrite,
  canDelete,
  onSelect,
}: {
  cameras: Camera[];
  canWrite: boolean;
  canDelete: boolean;
  onSelect?: (id: string) => void;
}) {
  const { notify } = useToast();

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Cameras in the registry with their measured trust band, catalogue presence and health
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
            <th scope="col" className="px-4 py-3 font-medium">
              Catalogue
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Health
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Mapped
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
            // From the API. Never `camera.trustScore >= 70`.
            const key = bandKeyOf(camera.band);
            const style = BAND_STYLE[key];
            const placed = camera.lat !== null && camera.lon !== null;
            return (
              <tr key={camera.id} className="hover:bg-slate-900/40">
                <td className="px-4 py-3">
                  <button
                    type="button"
                    data-row={camera.externalId}
                    onClick={() => onSelect?.(camera.id)}
                    className="text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                  >
                    <span className="block font-medium text-slate-200">{camera.externalId}</span>
                    <span className="block text-xs text-slate-400">{camera.name}</span>
                  </button>
                </td>
                <td className="px-4 py-3 text-slate-400">{camera.district ?? '—'}</td>
                <td className="px-4 py-3 text-slate-400">{camera.adapterKind}</td>
                <td className="px-4 py-3">
                  <span className={`${CHIP} ${style.chip}`} data-band={key} title={style.meaning}>
                    {camera.trustScore === null
                      ? style.label
                      : `${camera.trustScore.toFixed(0)} · ${style.label}`}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`${CHIP} ${CATALOGUE_STATUS_CHIP[camera.catalogueStatus] ?? ''}`}
                  >
                    {camera.catalogueStatus}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`${CHIP} ${HEALTH_STATUS_CHIP[camera.status] ?? ''}`}>
                    {camera.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs">
                  {placed ? (
                    <span className="text-slate-400">
                      {(camera.lat as number).toFixed(3)}, {(camera.lon as number).toFixed(3)}
                    </span>
                  ) : (
                    <span className="text-amber-400">no coordinates</span>
                  )}
                </td>
                {canWrite || canDelete ? (
                  <td className="px-4 py-3">
                    <span className="flex gap-2">
                      {canWrite ? (
                        <button
                          type="button"
                          onClick={() => {
                            notify(
                              `Editing ${camera.externalId} lands with the onboarding workflow ticket.`,
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
                            // already attached to it.
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
