/**
 * The retention chip — one component, rendered on the evidence screen, the alert detail and the
 * trace timeline.
 *
 * It reads `retention.state` and `retention.label` straight from the API payload. It computes
 * nothing: the countdown, the threshold and the verdict were all decided server-side by the shared
 * clock, and a chip that re-derived any of them would be a second implementation of the arithmetic
 * an officer is relying on.
 */
import type { RetentionState } from '@saakshi/shared';
import { RETENTION_STYLE, retentionWindowLabel } from '@/src/lib/evidence/retention';

export interface RetentionChipProps {
  retention: {
    state: RetentionState;
    label: string;
    retentionDays: number | null;
    expiresOnIstDate: string | null;
    expiringSoonHours: number;
  };
  /** Adds the declared window alongside the countdown. Off in dense tables. */
  showWindow?: boolean;
  testId?: string;
}

export function RetentionChip({ retention, showWindow = false, testId }: RetentionChipProps) {
  const style = RETENTION_STYLE[retention.state];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${style.chip}`}
      data-testid={testId ?? 'retention-chip'}
      data-state={retention.state}
      title={
        retention.state === 'unknown'
          ? style.meaning
          : `${style.meaning} Warning threshold: ${String(retention.expiringSoonHours)} h.`
      }
    >
      <span>{style.label}</span>
      <span className="font-mono tabular-nums opacity-80">{retention.label}</span>
      {showWindow ? (
        <span className="opacity-60">· {retentionWindowLabel(retention.retentionDays)}</span>
      ) : null}
    </span>
  );
}

/** The legend. A colour on its own asserts more than it can support, so the words travel with it. */
export function RetentionLegend() {
  return (
    <dl className="grid gap-2 text-xs sm:grid-cols-2" data-testid="retention-legend">
      {(Object.keys(RETENTION_STYLE) as RetentionState[]).map((state) => (
        <div key={state} className="flex items-start gap-2">
          <dt
            className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 font-medium ${RETENTION_STYLE[state].chip}`}
          >
            {RETENTION_STYLE[state].label}
          </dt>
          <dd className="text-slate-400">{RETENTION_STYLE[state].meaning}</dd>
        </div>
      ))}
    </dl>
  );
}
