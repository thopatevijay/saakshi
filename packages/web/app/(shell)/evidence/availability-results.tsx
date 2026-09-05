/**
 * The answer to "what covered this place at this time, and does it still exist".
 *
 * Two lists, kept apart on purpose (D1-08's tray pattern):
 *
 * - **Covering** — cameras whose registered position falls inside the radius.
 * - **Could not be assessed** — cameras with no registered position at all. They can be ruled
 *   neither in nor out, and an officer shown an empty covering list without this count has been told
 *   something false. Their retention clock still runs, and is still shown: *unplaced* and *unknown
 *   retention* are different facts and this screen refuses to conflate them.
 */
import { RetentionChip } from './retention-chip';
import type { Availability } from './types';

const LABEL = 'text-[11px] font-semibold tracking-wide text-slate-400 uppercase';

function CameraTable({
  rows,
  showDistance,
  testId,
}: {
  rows: Availability['covering'];
  showDistance: boolean;
  testId: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full border-collapse text-left text-sm" data-testid={testId}>
        <thead>
          <tr className="bg-slate-900/60">
            <th className={`px-3 py-2 ${LABEL}`}>Camera</th>
            <th className={`px-3 py-2 ${LABEL}`}>District</th>
            <th className={`px-3 py-2 ${LABEL}`}>Owning department</th>
            {showDistance ? <th className={`px-3 py-2 text-right ${LABEL}`}>Distance</th> : null}
            <th className={`px-3 py-2 ${LABEL}`}>Retention</th>
            <th className={`px-3 py-2 ${LABEL}`}>Expires (IST)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((camera) => (
            <tr key={camera.cameraId} className="border-t border-slate-800" data-testid="camera-row">
              <td className="px-3 py-2 text-slate-200">
                <span className="font-mono">{camera.externalId}</span>
                <span className="ml-2 text-slate-500">{camera.name}</span>
              </td>
              <td className="px-3 py-2 text-slate-400">{camera.district ?? '—'}</td>
              <td className="px-3 py-2 text-slate-400">
                {camera.departmentName ?? <span className="text-slate-600">not recorded</span>}
              </td>
              {showDistance ? (
                <td className="px-3 py-2 text-right font-mono text-slate-400 tabular-nums">
                  {camera.distanceM === null ? '—' : `${String(camera.distanceM)} m`}
                </td>
              ) : null}
              <td className="px-3 py-2">
                <RetentionChip retention={camera.retention} showWindow />
              </td>
              <td className="px-3 py-2 font-mono text-xs text-slate-400 tabular-nums">
                {camera.retention.expiresOnIstDate ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AvailabilityResults({ availability }: { availability: Availability | null }) {
  if (availability === null) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-6 text-sm text-slate-400">
        Enter a location and the time the incident happened. The answer is: which cameras were
        within reach, and for each of them, whether that footage is still inside the retention
        window its department declared.
      </section>
    );
  }

  const { counts } = availability;

  return (
    <section className="space-y-4" data-testid="availability-results">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-100">
          Covering cameras · {counts.covering}
        </h2>
        <p className="text-xs text-slate-500 tabular-nums" data-testid="availability-counts">
          {counts.byState['available'] ?? 0} available · {counts.byState['expiring_soon'] ?? 0}{' '}
          expiring soon · {counts.byState['expired'] ?? 0} expired ·{' '}
          {counts.byState['unknown'] ?? 0} not declared
        </p>
      </div>

      {counts.covering === 0 ? (
        <p
          className="rounded-md border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-300"
          data-testid="availability-empty"
        >
          No camera in the registry has a position inside this radius.{' '}
          <strong className="font-semibold text-slate-100">
            That is not the same as “no camera saw it”.
          </strong>{' '}
          {counts.unassessable.toLocaleString('en-GB')} camera
          {counts.unassessable === 1 ? '' : 's'} in the registry carry no coordinates at all and are
          listed below — they can be ruled neither in nor out until somebody surveys them.
        </p>
      ) : (
        <CameraTable rows={availability.covering} showDistance testId="covering-table" />
      )}

      <details className="rounded-lg border border-slate-800 bg-slate-900/40" open={counts.covering === 0}>
        <summary
          className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-200"
          data-testid="unassessable-summary"
        >
          Could not be assessed · {counts.unassessable.toLocaleString('en-GB')}
          <span className="ml-2 font-normal text-slate-500">
            no registered position, so coverage cannot be decided either way
          </span>
        </summary>
        <div className="border-t border-slate-800 p-3">
          {availability.unassessable.length === 0 ? (
            <p className="text-sm text-slate-400">Every camera in the registry has a position.</p>
          ) : (
            <CameraTable
              rows={availability.unassessable}
              showDistance={false}
              testId="unassessable-table"
            />
          )}
        </div>
      </details>

      <p className="text-xs text-slate-500" data-testid="coverage-model-note">
        {availability.coverageModelNote}
      </p>
    </section>
  );
}
