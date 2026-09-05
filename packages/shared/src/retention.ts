/**
 * The retention clock (D3-05).
 *
 * The most departmentally useful arithmetic in the build, and the easiest to get subtly wrong. The
 * problem statement says footage is kept *"for 7 days and others for 15 days or more"*, per
 * department — so evidence expires silently, and on day 12 nobody in Gujarat can tell an
 * investigating officer what still exists. This module is the answer to "what can I still get, and
 * how long do I have".
 *
 * It is deliberately **pure and shared**: the API computes states for its responses and the web app
 * renders badges, and two implementations of the same countdown would eventually disagree in front
 * of somebody who was relying on it.
 *
 * ## The model
 *
 * A recorder keeps a rolling window. Footage recorded at `t` is overwritten at
 * `t + retentionDays x 24 h`. That is the model this file implements, and `docs/retention-model.md`
 * says so in as many words, because two other models exist in the wild — end-of-Nth-calendar-day
 * regimes, and quota-driven recorders that overwrite when the disk fills rather than when the clock
 * runs out. We report the rolling window because it is the one a department's stated
 * "retention_days" figure describes, and we say plainly that we are reporting *the department's
 * declared policy*, not an observed fact about their disk.
 *
 * ## Why IST is named in the acceptance criterion
 *
 * India Standard Time is UTC+05:30 with **no daylight saving**, and has been since 1945. That is
 * what makes "add 24 hours" and "add one calendar day" the same operation here — a countdown built
 * this way in a DST jurisdiction would be an hour wrong twice a year, at exactly the boundary where
 * somebody is asking whether evidence still exists. The offset is fixed and applied arithmetically
 * rather than through `Intl`/`TZ` lookups, so the answer cannot change with the host's tzdata.
 *
 * ## `null` is not zero and not a default
 *
 * D1-05's rule, inherited through D1-06: *an unmeasurable value must never be scored as a bad one*.
 * A camera whose department never declared a retention period is `unknown` — not 7 days, not 15,
 * not expired. An officer told "expired" about footage that may well still exist is worse off than
 * one told "we do not know, ring the owning department". The `unknown` state carries a `null`
 * expiry and `null` remaining time so a caller cannot read a number that was never measured.
 */
import { z } from 'zod';

/** India Standard Time, UTC+05:30, no daylight saving. Fixed since 1945. */
export const IST_OFFSET_MINUTES = 330;
export const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/**
 * How close to expiry counts as "expiring soon", when nothing overrides it.
 *
 * 48 hours is the ticket's default and it is a working figure, not a law: two working days is about
 * the shortest notice on which a request to another department can realistically be actioned. It is
 * overridable per deployment (`RETENTION_EXPIRING_SOON_HOURS`) and per query, because a district
 * with a slower evidence desk needs a longer fuse.
 */
export const DEFAULT_EXPIRING_SOON_HOURS = 48;

export const RetentionState = z.enum(['available', 'expiring_soon', 'expired', 'unknown']);
export type RetentionState = z.infer<typeof RetentionState>;

/**
 * The exact sentence the UI must render next to a preservation request.
 *
 * Exported as a constant and asserted by tests for the same reason D3-04 exports `CHAIN_CLAIM`: a
 * paraphrase drifts, and the paraphrase that drifts is always the one that quietly starts implying
 * more than the system does. SAAKSHI does not operate any department's recorder and cannot extend
 * anybody's retention. It records an instruction and makes it auditable. That is the whole claim.
 */
export const PRESERVATION_DISCLAIMER =
  'A preservation request is an instruction to the owning department, recorded and audited here. ' +
  'It does NOT extend retention automatically: SAAKSHI does not operate the recorder and cannot ' +
  'stop it overwriting. The owning department must act on this request before the expiry shown.';

/** The sentence that keeps the availability answer from being read as an observation of the disk. */
export const RETENTION_DISCLAIMER =
  'Retention states are computed from the retention period each department declared in the ' +
  'registry, not from an inspection of that department’s recorder. A camera whose department has ' +
  'declared no retention period is reported as unknown and is never assumed to be either.';

export const RetentionStatus = z.object({
  state: RetentionState,
  /** The declared window, in days. `null` when the department never declared one. */
  retentionDays: z.number().int().nonnegative().nullable(),
  /** When the footage recorded at `footageAt` is overwritten. `null` when `state` is `unknown`. */
  expiresAt: z.iso.datetime().nullable(),
  /** Milliseconds left. Negative once expired. `null` when `state` is `unknown`. */
  remainingMs: z.number().int().nullable(),
  /** Whole days left, truncated toward zero. `null` when `state` is `unknown`. */
  remainingDays: z.number().int().nullable(),
  /** Hours left *within* the final day, `0-23`. Pairs with `remainingDays`. `null` when unknown. */
  remainingHours: z.number().int().nullable(),
  /** The threshold this status was computed against, so a rendered badge can explain itself. */
  expiringSoonHours: z.number().nonnegative(),
  /** The instant the countdown was taken from. A status is a snapshot, and it says when. */
  computedAt: z.iso.datetime(),
  /** IST calendar date the footage expires on, `YYYY-MM-DD`. `null` when unknown. */
  expiresOnIstDate: z.string().nullable(),
  /** Human phrase for the badge: `4d 6h left`, `expired 2d ago`, `retention not declared`. */
  label: z.string(),
});
export type RetentionStatus = z.infer<typeof RetentionStatus>;

export interface RetentionInput {
  /** When the footage was recorded. PTS-derived, never ingest time. */
  footageAt: Date | string;
  /** `cameras.retention_days`. `null` means the department never declared one. */
  retentionDays: number | null;
  /** Defaults to now. Injected so the countdown is testable at a boundary rather than near one. */
  now?: Date | string;
  expiringSoonHours?: number;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * The IST calendar date of an instant, as `YYYY-MM-DD`.
 *
 * Computed by shifting the epoch and reading the *UTC* fields of the shifted instant, which is
 * exact for a fixed-offset zone and needs no tzdata. `toLocaleDateString('en-IN', ...)` would go
 * through the host's ICU and produce a different string on a host with a different locale build.
 */
export function istDate(value: Date | string): string {
  const shifted = new Date(asDate(value).getTime() + IST_OFFSET_MS);
  const y = String(shifted.getUTCFullYear()).padStart(4, '0');
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `2026-09-05 14:32 IST`. The form a case file wants; never a bare UTC timestamp. */
export function istDateTime(value: Date | string): string {
  const shifted = new Date(asDate(value).getTime() + IST_OFFSET_MS);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${istDate(value)} ${hh}:${mm} IST`;
}

/**
 * Midnight IST at the start of the IST calendar day containing `value`, as a UTC instant.
 *
 * The "across day boundaries" half of AC 2. `daysBetweenIstDates` counts *calendar* days between
 * two instants, which is the number an officer actually reasons in: footage from "Tuesday" expires
 * "next Tuesday", regardless of whether it was recorded at 00:05 or 23:55.
 */
export function istMidnight(value: Date | string): Date {
  const shifted = new Date(asDate(value).getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}

/** Whole IST calendar days from `from` to `to`. Negative when `to` is the earlier date. */
export function istCalendarDaysBetween(from: Date | string, to: Date | string): number {
  return Math.round((istMidnight(to).getTime() - istMidnight(from).getTime()) / MS_PER_DAY);
}

/**
 * When footage recorded at `footageAt` is overwritten, or `null` when nothing was declared.
 *
 * `retentionDays: 0` is a real, declarable answer — "we keep nothing" — and expires the footage at
 * the instant it was recorded. It is deliberately distinct from `null`, which is "we did not say".
 */
export function expiryOf(footageAt: Date | string, retentionDays: number | null): Date | null {
  if (retentionDays === null) return null;
  return new Date(asDate(footageAt).getTime() + retentionDays * MS_PER_DAY);
}

function labelFor(state: RetentionState, remainingMs: number | null): string {
  if (state === 'unknown' || remainingMs === null) return 'retention not declared';

  const abs = Math.abs(remainingMs);
  const days = Math.floor(abs / MS_PER_DAY);
  const hours = Math.floor((abs % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((abs % MS_PER_HOUR) / 60_000);

  const magnitude =
    days > 0
      ? `${String(days)}d ${String(hours)}h`
      : hours > 0
        ? `${String(hours)}h ${String(minutes)}m`
        : `${String(minutes)}m`;

  return remainingMs <= 0 ? `expired ${magnitude} ago` : `${magnitude} left`;
}

/**
 * The whole clock, in one call.
 *
 * The boundaries, stated once so the tests can pin them and nobody has to re-derive them from an
 * inequality: expiry is **inclusive of the last instant** — at exactly `expiresAt` the footage is
 * `expired`, because a recorder that keeps 7 days has, at the 7-day mark, already overwritten it.
 * The `expiring_soon` threshold is likewise inclusive: at exactly 48 h remaining, with a 48 h
 * threshold, the state is `expiring_soon`. Both boundaries lean toward warning the officer.
 */
export function describeRetention(input: RetentionInput): RetentionStatus {
  const now = asDate(input.now ?? new Date());
  const expiringSoonHours = input.expiringSoonHours ?? DEFAULT_EXPIRING_SOON_HOURS;
  const expiresAt = expiryOf(input.footageAt, input.retentionDays);

  if (expiresAt === null) {
    return {
      state: 'unknown',
      retentionDays: null,
      expiresAt: null,
      remainingMs: null,
      remainingDays: null,
      remainingHours: null,
      expiringSoonHours,
      computedAt: now.toISOString(),
      expiresOnIstDate: null,
      label: labelFor('unknown', null),
    };
  }

  const remainingMs = expiresAt.getTime() - now.getTime();
  const state: RetentionState =
    remainingMs <= 0
      ? 'expired'
      : remainingMs <= expiringSoonHours * MS_PER_HOUR
        ? 'expiring_soon'
        : 'available';

  // Truncated toward zero on both sides of the boundary, so `remainingDays`/`remainingHours` read
  // as a magnitude with the sign carried by `state` — `-1d 3h` is not a phrase anyone wants.
  const abs = Math.abs(remainingMs);

  return {
    state,
    retentionDays: input.retentionDays,
    expiresAt: expiresAt.toISOString(),
    remainingMs: Math.trunc(remainingMs),
    remainingDays: Math.floor(abs / MS_PER_DAY) * (remainingMs < 0 ? -1 : 1),
    remainingHours: Math.floor((abs % MS_PER_DAY) / MS_PER_HOUR),
    expiringSoonHours,
    computedAt: now.toISOString(),
    expiresOnIstDate: istDate(expiresAt),
    label: labelFor(state, remainingMs),
  };
}

/** Ordering for a queue or a table: the most urgent first, the unknowable last. */
export const RETENTION_STATE_ORDER: Readonly<Record<RetentionState, number>> = {
  expired: 0,
  expiring_soon: 1,
  available: 2,
  unknown: 3,
};

/** One sentence per state, for a legend. The `unknown` line is the one that matters. */
export const RETENTION_STATE_MEANING: Readonly<Record<RetentionState, string>> = {
  available: 'Within the declared retention window. Request it now and it should still exist.',
  expiring_soon: 'Inside the warning threshold. Preserve it before the window closes.',
  expired: 'Past the declared retention window. It has probably been overwritten.',
  unknown:
    'The owning department has declared no retention period, so nothing can be said about this ' +
    'footage either way. Contact the department — do not assume it is gone.',
};
