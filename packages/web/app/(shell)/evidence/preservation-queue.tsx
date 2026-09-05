/**
 * The preservation queue.
 *
 * Sorted most-urgent-first by the API, on the retention state recomputed against now rather than on
 * the figure snapshotted when the request was made — a queue ordered by the frozen number would put
 * last week's comfortable request above this morning's one about footage expiring in an hour.
 *
 * Every row shows the chain entry that authorised it. Not decoration: it is what turns "somebody
 * says they asked" into something a court can check, and it is the difference between this queue and
 * a spreadsheet.
 */
import { RetentionChip } from './retention-chip';
import type { PreservationQueue as Queue } from './types';

const LABEL = 'text-[11px] font-semibold tracking-wide text-slate-400 uppercase';

const STATUS_CHIP: Record<string, string> = {
  open: 'border-sky-800 bg-sky-950/60 text-sky-300',
  acknowledged: 'border-indigo-800 bg-indigo-950/60 text-indigo-300',
  preserved: 'border-emerald-800 bg-emerald-950/60 text-emerald-300',
  declined: 'border-slate-700 bg-slate-800/60 text-slate-400',
};

function istStamp(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

export function PreservationQueue({ queue }: { queue: Queue | null }) {
  if (queue === null) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-400">
        The preservation queue could not be read.
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="preservation-queue">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-100">Preservation queue</h2>
        <p className="text-xs text-slate-500 tabular-nums">
          {queue.counts.open} open · {queue.counts.acknowledged} acknowledged ·{' '}
          {queue.counts.preserved} preserved · {queue.counts.declined} declined
        </p>
      </div>

      {queue.data.length === 0 ? (
        <p className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-6 text-sm text-slate-400">
          Nothing on the queue. A request appears here the moment it is recorded, and stays until the
          owning department reports what it did about it.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full min-w-4xl border-collapse text-left text-sm">
            <thead>
              <tr className="bg-slate-900/60">
                <th className={`px-3 py-2 ${LABEL}`}>Status</th>
                <th className={`px-3 py-2 ${LABEL}`}>Case</th>
                <th className={`px-3 py-2 ${LABEL}`}>Camera</th>
                <th className={`px-3 py-2 ${LABEL}`}>Owning department</th>
                <th className={`px-3 py-2 ${LABEL}`}>Window (IST)</th>
                <th className={`px-3 py-2 ${LABEL}`}>Clock now</th>
                <th className={`px-3 py-2 ${LABEL}`}>Asked by</th>
                <th className={`px-3 py-2 ${LABEL}`}>Chain entry</th>
              </tr>
            </thead>
            <tbody>
              {queue.data.map((row) => (
                <tr key={row.id} className="border-t border-slate-800" data-testid="preservation-row">
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                        STATUS_CHIP[row.status] ?? STATUS_CHIP['declined'] ?? ''
                      }`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-200">{row.caseRef}</td>
                  <td className="px-3 py-2 text-slate-200">
                    <span className="font-mono">{row.cameraExternalId}</span>
                    <span className="ml-2 text-slate-500">{row.cameraName}</span>
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {row.departmentName ?? <span className="text-slate-600">not recorded</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-400 tabular-nums">
                    {istStamp(row.windowStart)} → {istStamp(row.windowEnd)}
                  </td>
                  <td className="px-3 py-2">
                    <RetentionChip retention={row.retention} testId="queue-retention" />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-400">
                    {row.requestedByBadgeNo ?? '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">
                    {row.auditHash.slice(0, 12)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-500" data-testid="queue-disclaimer">
        {queue.disclaimer}
      </p>
    </section>
  );
}
