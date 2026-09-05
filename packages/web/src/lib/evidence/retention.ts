/**
 * Retention presentation — the one place a retention state becomes a colour and a phrase.
 *
 * The rule is the one `registry/trust.ts` enforces for trust bands, for the same reason: **the state
 * is never computed here.** It arrives on the API payload as `retention.state`, and every function
 * below is a lookup keyed on that value. A screen that re-derived "expired" from a timestamp would
 * be a second implementation of the countdown, and the two would eventually disagree in front of an
 * officer who was relying on one of them.
 *
 * `unknown` gets a **dashed** chip rather than a paler shade of anything. "The department never told
 * us how long this lasts" and "we know, and it has gone" are different findings, and an officer told
 * the second when the first is true stops looking for footage that may well still exist.
 */
import type { RetentionState } from '@saakshi/shared';

export const RETENTION_STATES: readonly RetentionState[] = [
  'available',
  'expiring_soon',
  'expired',
  'unknown',
];

export interface RetentionStyle {
  readonly label: string;
  /** Tailwind classes for the chip. `unknown` is dashed — a different shape, not a paler colour. */
  readonly chip: string;
  /** What the chip actually asserts, for the legend. A colour on its own overstates. */
  readonly meaning: string;
}

export const RETENTION_STYLE: Record<RetentionState, RetentionStyle> = {
  available: {
    label: 'Available',
    chip: 'border-emerald-800 bg-emerald-950/60 text-emerald-300',
    meaning:
      'Within the retention period the owning department declared. Request it now and it should ' +
      'still exist.',
  },
  expiring_soon: {
    label: 'Expiring soon',
    chip: 'border-amber-800 bg-amber-950/60 text-amber-300',
    meaning:
      'Inside the warning threshold. If this footage matters, the preservation request has to go ' +
      'to the owning department now.',
  },
  expired: {
    label: 'Expired',
    chip: 'border-rose-800 bg-rose-950/60 text-rose-300',
    meaning:
      'Past the declared retention period. It has probably been overwritten — but the declared ' +
      'period is a policy, not an observation of the disk, so ask before concluding.',
  },
  unknown: {
    label: 'Not declared',
    chip: 'border-dashed border-slate-600 bg-slate-900/60 text-slate-300',
    meaning:
      'The owning department has declared no retention period, so nothing can be said about this ' +
      'footage either way. Contact the department — never assume it is gone.',
  },
};

/** Sort order for a queue or a table: the most urgent first, the unknowable last. */
export const RETENTION_SORT: Record<RetentionState, number> = {
  expired: 0,
  expiring_soon: 1,
  available: 2,
  unknown: 3,
};

export function retentionStyleOf(state: RetentionState): RetentionStyle {
  return RETENTION_STYLE[state];
}

/**
 * The retention window as a human phrase — `7 days`, `not declared`.
 *
 * `0` is a real declared answer ("we keep nothing") and must not collapse into the `null` case, so
 * the check is on `null` explicitly rather than on falsiness.
 */
export function retentionWindowLabel(retentionDays: number | null): string {
  if (retentionDays === null) return 'not declared';
  if (retentionDays === 0) return 'kept for 0 days';
  return `${String(retentionDays)} day${retentionDays === 1 ? '' : 's'}`;
}

/**
 * The sentence an alert detail shows: *this evidence expires in N days*.
 *
 * Reads the label the API already computed rather than re-deriving one, so the phrasing on the
 * alert, on the trace and on the evidence screen cannot drift apart.
 */
export function evidenceClockSentence(status: {
  state: RetentionState;
  label: string;
  expiresOnIstDate: string | null;
}): string {
  if (status.state === 'unknown') {
    return 'This camera’s department has declared no retention period — how long this evidence survives is unknown.';
  }
  if (status.state === 'expired') {
    return `This evidence ${status.label}${
      status.expiresOnIstDate === null ? '' : ` (window closed ${status.expiresOnIstDate} IST)`
    }.`;
  }
  return `This evidence expires in ${status.label.replace(/ left$/, '')}${
    status.expiresOnIstDate === null ? '' : ` — ${status.expiresOnIstDate} IST`
  }.`;
}
