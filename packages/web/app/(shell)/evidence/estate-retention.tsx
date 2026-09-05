/**
 * The estate's retention posture.
 *
 * The bar is deliberately blunt about the shape of the finding: on the Gujarat sandbox estate every
 * bucket except "not declared" is empty, because the upstream catalogue publishes `{id, name}` and
 * nothing else. That is not a gap in this screen — it is the reason the whole feature exists, and it
 * is stated in words above the chart rather than left for a viewer to infer from an empty bar.
 */
import { retentionWindowLabel } from '@/src/lib/evidence/retention';
import type { RetentionSummary } from './types';

const LABEL = 'text-[11px] font-semibold tracking-wide text-slate-400 uppercase';

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

export function EstateRetention({ summary }: { summary: RetentionSummary | null }) {
  if (summary === null) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-400">
        The estate’s retention posture could not be read. That is a fault in this screen, not a
        finding about the estate.
      </section>
    );
  }

  const { totalCameras, declared, undeclared } = summary;

  return (
    <section className="space-y-4" data-testid="estate-retention">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-100">Estate retention</h2>
        <p className="text-xs text-slate-500 tabular-nums">
          {totalCameras.toLocaleString('en-GB')} cameras · {declared.toLocaleString('en-GB')}{' '}
          declared · {undeclared.toLocaleString('en-GB')} not declared
        </p>
      </div>

      {undeclared === totalCameras && totalCameras > 0 ? (
        <p
          className="rounded-md border border-amber-900/60 bg-amber-950/20 px-4 py-3 text-sm text-amber-200"
          data-testid="estate-all-undeclared"
        >
          <strong className="font-semibold">
            No camera on this estate declares a retention period.
          </strong>{' '}
          The upstream catalogue publishes an identifier and a name and nothing else, so for every
          one of these {totalCameras.toLocaleString('en-GB')} cameras the question “how long does
          this footage last” currently has no answer anywhere. That is the finding, not a gap in this
          screen — and it is exactly why an officer reporting a crime on day 12 cannot be told what
          still exists.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="bg-slate-900/60">
              <th className={`px-3 py-2 ${LABEL}`}>Declared window</th>
              <th className={`px-3 py-2 text-right ${LABEL}`}>Cameras</th>
              <th className={`px-3 py-2 text-right ${LABEL}`}>Share</th>
              <th className={`px-3 py-2 ${LABEL}`}>&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {summary.buckets.map((bucket) => {
              const share = pct(bucket.cameras, totalCameras);
              const undeclaredBucket = bucket.retentionDays === null;
              return (
                <tr
                  key={String(bucket.retentionDays)}
                  className="border-t border-slate-800"
                  data-testid={`retention-bucket-${String(bucket.retentionDays)}`}
                >
                  <td className="px-3 py-2 text-slate-200">
                    {undeclaredBucket ? (
                      <span className="text-slate-400">Not declared</span>
                    ) : (
                      retentionWindowLabel(bucket.retentionDays)
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-200 tabular-nums">
                    {bucket.cameras.toLocaleString('en-GB')}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400 tabular-nums">
                    {share}%
                  </td>
                  <td className="px-3 py-2">
                    <div className="h-2 w-full min-w-24 rounded-full bg-slate-800">
                      <div
                        className={`h-2 rounded-full ${undeclaredBucket ? 'bg-slate-600' : 'bg-sky-600'}`}
                        style={{ width: `${String(share)}%` }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="bg-slate-900/60">
              <th className={`px-3 py-2 ${LABEL}`}>Department</th>
              <th className={`px-3 py-2 text-right ${LABEL}`}>Cameras</th>
              <th className={`px-3 py-2 text-right ${LABEL}`}>Declared</th>
              <th className={`px-3 py-2 text-right ${LABEL}`}>Not declared</th>
              <th className={`px-3 py-2 ${LABEL}`}>Window range</th>
            </tr>
          </thead>
          <tbody>
            {summary.byDepartment.map((row) => (
              <tr
                key={row.departmentId ?? 'unassigned'}
                className="border-t border-slate-800"
                data-testid="retention-department-row"
              >
                <td className="px-3 py-2 text-slate-200">
                  {row.departmentName ?? (
                    <span className="text-slate-500">No owning department recorded</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-200 tabular-nums">
                  {row.cameras.toLocaleString('en-GB')}
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-400 tabular-nums">
                  {row.declared.toLocaleString('en-GB')}
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-400 tabular-nums">
                  {row.undeclared.toLocaleString('en-GB')}
                </td>
                <td className="px-3 py-2 text-slate-400">
                  {row.minRetentionDays === null
                    ? '—'
                    : row.minRetentionDays === row.maxRetentionDays
                      ? retentionWindowLabel(row.minRetentionDays)
                      : `${retentionWindowLabel(row.minRetentionDays)} – ${retentionWindowLabel(row.maxRetentionDays)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500" data-testid="retention-disclaimer">
        {summary.disclaimer}
      </p>
    </section>
  );
}
