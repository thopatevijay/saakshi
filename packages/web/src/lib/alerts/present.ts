/**
 * How an alert is allowed to look (D2-07).
 *
 * Every rule that stops this screen overclaiming lives here rather than inside a component, for two
 * reasons: it is testable without a DOM, and there is exactly one place to check when somebody asks
 * *"can this UI imply a vehicle was identified?"* The answer has to be no, and on this estate it has
 * to be no **loudly** —
 *
 *   - D2-01 measured **0 exact plate reads** across a 120-instance hand-labelled sample; only 3 of
 *     those 120 carried a human-legible plate at all.
 *   - D2-03 rejected all 15 strings the live run produced, including `757508300` — a hoarding's
 *     phone number, and the highest-confidence read of the entire run at 0.888.
 *   - D2-08 opened all six evidence crops by hand and could not confirm a single sighting as the
 *     vehicle: five illegible plate regions, one Gujarati shop sign the detector kept as a plate.
 *
 * So "verify in three seconds" here does **not** mean "trust the badge in three seconds". It means
 * reaching the right verdict in three seconds, and on this estate the right verdict is usually
 * *this is not identifiable*. `readability()` is the function that says so, and the row leads with
 * it — before the severity, before the score.
 *
 * Colours are D2-08's `LINK_STYLE` vocabulary, deliberately: sky is an exact plate match, amber is
 * a ranked possibility. An operator who learns the colours on the trace screen must not have to
 * relearn them on the queue.
 */
import type {
  AlertSeverity,
  AlertStatus,
  IdentificationStrength,
  MatchType,
  WatchlistCategory,
} from '@saakshi/shared';

export interface Swatch {
  /** Tailwind classes for a chip: border, background, text. */
  chip: string;
  /** The 4 px rail down the left of the row. */
  rail: string;
  label: string;
}

/**
 * Severity, as a colour and a word.
 *
 * `low` is deliberately not grey-on-grey. Five of the seven alerts this estate produces are `low`,
 * and a queue that renders its entire contents as visual noise has told the operator nothing.
 */
export const SEVERITY_STYLE: Readonly<Record<AlertSeverity, Swatch>> = {
  critical: {
    chip: 'border-rose-700 bg-rose-950/60 text-rose-200',
    rail: 'bg-rose-500',
    label: 'Critical',
  },
  high: {
    chip: 'border-orange-700 bg-orange-950/50 text-orange-200',
    rail: 'bg-orange-500',
    label: 'High',
  },
  medium: {
    chip: 'border-amber-700 bg-amber-950/40 text-amber-200',
    rail: 'bg-amber-500',
    label: 'Medium',
  },
  low: {
    chip: 'border-slate-600 bg-slate-800/60 text-slate-300',
    rail: 'bg-slate-500',
    label: 'Low',
  },
};

/**
 * Exact versus fuzzy — the distinction the ticket calls out and `CLAUDE.md` scores.
 *
 * Three signals, not one, because colour alone fails a colour-blind operator and a monochrome
 * printout: a different **colour**, a different **border weight**, and a different **word**.
 */
export const MATCH_STYLE: Readonly<
  Record<MatchType, Swatch & { border: string; short: string; caution: string }>
> = {
  exact: {
    chip: 'border-sky-700 bg-sky-950/50 text-sky-200',
    rail: 'bg-sky-500',
    border: 'border-l-4 border-l-sky-500',
    label: 'Exact string match',
    short: 'EXACT',
    caution: 'The read is identical to the watchlist string. That is a string, not a vehicle.',
  },
  fuzzy: {
    chip: 'border-amber-600 bg-amber-950/40 text-amber-200 border-dashed',
    rail: 'bg-amber-500',
    border: 'border-l-4 border-l-amber-500 border-dashed',
    label: 'Fuzzy match',
    short: 'FUZZY',
    caution: 'A ranked possibility, not an identification.',
  },
};

/** The word the row leads with. D2-06 is explicit: the word first, the number beside it. */
export const STRENGTH_COPY: Readonly<
  Record<IdentificationStrength, { label: string; tone: string; means: string }>
> = {
  confirmed: {
    label: 'Confirmed',
    tone: 'text-sky-200',
    means: 'An exact match on a grammar-valid registration.',
  },
  probable: {
    label: 'Probable',
    tone: 'text-emerald-200',
    means: 'A strong match, but still a match against a watchlist string.',
  },
  possible: {
    label: 'Possible',
    tone: 'text-amber-200',
    means: 'A lead. More than one vehicle can satisfy this read.',
  },
  weak: {
    label: 'Weak',
    tone: 'text-rose-200',
    means: 'The read does not support an identification.',
  },
};

export const CATEGORY_LABEL: Readonly<Record<WatchlistCategory, string>> = {
  stolen_vehicle: 'Stolen vehicle',
  blacklisted_vehicle: 'Blacklisted vehicle',
  wanted_person: 'Wanted person',
  missing_person: 'Missing person',
  suspect: 'Suspect',
};

export const STATUS_LABEL: Readonly<Record<AlertStatus, string>> = {
  new: 'New',
  ack: 'Acknowledged',
  dismissed: 'Dismissed',
  escalated: 'Escalated',
};

export const STATUS_STYLE: Readonly<Record<AlertStatus, string>> = {
  new: 'border-sky-700 bg-sky-950/40 text-sky-200',
  ack: 'border-slate-600 bg-slate-800/70 text-slate-300',
  escalated: 'border-violet-700 bg-violet-950/40 text-violet-200',
  dismissed: 'border-slate-700 bg-slate-900/70 text-slate-500',
};

/* ── the identification verdict ─────────────────────────────────────────────────────────────── */

export type ReadabilityKind = 'registration' | 'fragment' | 'not-a-registration';

export interface Readability {
  kind: ReadabilityKind;
  /** The headline the row leads with. Short enough to read in a glance. */
  headline: string;
  /** One sentence an officer can act on. */
  detail: string;
  tone: string;
  /**
   * `true` when the honest verdict is *this is not identifiable* — the fastest correct answer on
   * this estate, and the one the screen must make reachable without a click.
   */
  unidentifiable: boolean;
}

export interface ReadabilityInput {
  validity: 'valid' | 'partial' | 'invalid';
  grammarValid: boolean;
  observedPlate: string;
  watchlistValue: string;
  missingChars: number | null;
  rejectionCodes: readonly string[];
}

/**
 * What the read actually is, before anything about the match.
 *
 * This is the ordering the ticket's three-second test needs: an operator who sees *"not a
 * registration"* has finished — the alert is a string collision and the verdict is dismiss, and
 * no amount of severity colour changes that. Only a read that is a plausible registration is worth
 * the second and third seconds.
 */
export function readability(input: ReadabilityInput): Readability {
  if (input.validity === 'invalid' || input.observedPlate === '') {
    return {
      kind: 'not-a-registration',
      headline: 'Not a registration',
      detail:
        `The camera read “${input.observedPlate}”, which is not a valid Indian registration ` +
        `(${input.rejectionCodes.join(', ') || 'no layout matched'}). It matched a watchlist ` +
        `string, not a vehicle.`,
      tone: 'text-rose-300',
      unidentifiable: true,
    };
  }
  if (input.validity === 'partial' || !input.grammarValid) {
    const short = input.missingChars === null ? null : input.missingChars;
    return {
      kind: 'fragment',
      headline:
        short === null
          ? 'Partial read'
          : `Partial read — ${String(short)} character${short === 1 ? '' : 's'} short`,
      detail:
        `The camera read “${input.observedPlate}”, a fragment of “${input.watchlistValue}”. ` +
        `More than one vehicle can carry this prefix.`,
      tone: 'text-amber-300',
      unidentifiable: false,
    };
  }
  return {
    kind: 'registration',
    headline: 'Complete registration',
    detail: `The read “${input.observedPlate}” is a complete, grammar-valid Indian registration.`,
    tone: 'text-sky-300',
    unidentifiable: false,
  };
}

/* ── numbers ────────────────────────────────────────────────────────────────────────────────── */

/**
 * The weighted match distance, rendered as the continuous quantity it is.
 *
 * D2-04 and D2-06 both say this in writing and it is worth repeating in code: `GJ35U07 →
 * GJ35U0779` is **0.70**, not "1 character different". Two decimals, always — `0.7` printed as
 * `0.7` invites the reading "point seven of a character", and `1` printed as `1` invites the
 * reading "one character". `0` for an exact match prints as `0.00` for the same reason.
 */
export function formatDistance(distance: number): string {
  return distance.toFixed(2);
}

/** True when `toFixed(2)` lost information, so the UI can say it rounded rather than pretend. */
export function distanceWasRounded(distance: number): boolean {
  return Number(distance.toFixed(2)) !== distance;
}

/**
 * A `[0,1]` score as a percentage.
 *
 * Percent rather than the raw float because `0.345` reads as a probability of something, and it is
 * not one — it is the product of an OCR confidence and a match strength. The label beside it always
 * names which number it is; there is no bare score anywhere on this screen.
 */
export function formatScore(score: number): string {
  return `${String(Math.round(score * 100))}%`;
}

/* ── the crop ───────────────────────────────────────────────────────────────────────────────── */

export type CropState =
  | { kind: 'image'; url: string }
  | { kind: 'none'; reason: string }
  | { kind: 'unconfigured'; reason: string }
  | { kind: 'broken'; reason: string };

/**
 * What to draw where the plate crop goes.
 *
 * A missing crop is **shown**, never hidden, and the placeholder says which of three things
 * happened. On this estate `crop_uri` is null on all 28,438 sightings, so this placeholder is what
 * an operator will actually see — a blank tile would read as a loading bug.
 *
 * `broken` is the expired-URL path: D2-06 mints the signed URL per response with a 900 s life and
 * never stores it, so a queue left open for twenty minutes has dead links. The image's `onError`
 * feeds this, and the copy tells the operator the one thing that fixes it.
 */
export function cropState(
  evidence: { cropUri: string | null; cropUrl: string | null },
  failed = false,
): CropState {
  if (failed) {
    return {
      kind: 'broken',
      reason: 'The signed link expired (900 s). Refresh the queue to mint a new one.',
    };
  }
  if (evidence.cropUri === null) {
    return { kind: 'none', reason: 'No crop was stored for this sighting.' };
  }
  if (evidence.cropUrl === null) {
    return { kind: 'unconfigured', reason: 'A crop exists, but no object store is configured.' };
  }
  return { kind: 'image', url: evidence.cropUrl };
}

/* ── explained nulls ────────────────────────────────────────────────────────────────────────── */

/**
 * A field that may legitimately be `null`, rendered as the reason rather than as a zero.
 *
 * D1-06 is emphatic and D2-06 repeats it: a trust score of `null` is **unmeasured**, not zero. On
 * this estate *every* camera has `location: null` and `trustScore: null`, so a screen that rendered
 * either as `0` would put a false measurement in front of an officer on every single row.
 */
export function explainedNull(value: number | null, unmeasured: string): string {
  return value === null ? unmeasured : String(Math.round(value));
}

/* ── time ───────────────────────────────────────────────────────────────────────────────────── */

/** `14:02:31` in the browser's zone. Seconds included: a control room reads seconds. */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

/** `4 s`, `12 m`, `3 h`, `2 d` — how stale the row is, for the operator's sense of urgency. */
export function formatAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${String(seconds)} s`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} m`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))} h`;
  return `${String(Math.floor(seconds / 86_400))} d`;
}

/**
 * `ts`, `lastSeenAt` and `sightingCount` as the one sentence D2-06 says they are.
 *
 * A count above 1 is the loitering signal — a repeat sighting bumps the alert instead of raising a
 * new one, so "seen 23 times" means a vehicle that keeps coming back, not a noisy queue.
 */
export function sightingSentence(alert: {
  ts: string;
  lastSeenAt: string;
  sightingCount: number;
}): string {
  const first = formatClock(alert.ts);
  if (alert.sightingCount <= 1) return `seen once, ${first}`;
  return `first ${first}, again ${formatClock(alert.lastSeenAt)}, ${String(alert.sightingCount)} times`;
}

/**
 * The time window a "trace this vehicle" link should open with.
 *
 * An hour either side of the alert's own span. Wider than the alert, because an officer following a
 * vehicle wants where it came from and where it went, and narrow enough that the trace is not the
 * whole day.
 */
export function traceWindow(
  alert: { ts: string; lastSeenAt: string },
  padMinutes = 60,
): { from: string; to: string } {
  const pad = padMinutes * 60_000;
  return {
    from: new Date(Date.parse(alert.ts) - pad).toISOString(),
    to: new Date(Date.parse(alert.lastSeenAt) + pad).toISOString(),
  };
}
