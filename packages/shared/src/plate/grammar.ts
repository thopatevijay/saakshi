/**
 * Indian registration-plate grammar: validation, slot-aware correction, and confidence adjustment.
 *
 * Deterministic, pure, zero I/O, no model. See `docs/plate-grammar.md` for the format spec, the
 * sources, the confidence rule and — most importantly — why the corrector is deliberately
 * asymmetric.
 *
 * ## The two things this module exists to do
 *
 * **1 · Reject non-plates.** D2-01 measured the live estate: the highest-confidence plate read of
 * the entire 5-minute, 8-camera run was `757508300` at **0.888** — the phone number on a roadside
 * advertising hoarding on `cam05`. 15 of 120 hand-labelled instances are signage. A plate detector
 * is trained to find rectangular light-on-dark text regions, and a hoarding is exactly that. This
 * grammar is the only thing between that hoarding and a watchlist alert in D2-06.
 *
 * **2 · Report *why*, and report partial success.** The same run showed the failure mode is
 * **truncation, not garbling**: `GJ35U0779 -> GJ35U07`, `GJ32D0107 -> GJ32DD10`. A validator that
 * demands a complete 9-10 character registration returns "invalid" for essentially every read this
 * estate produces — technically correct and operationally useless. So `partial` is a first-class
 * result carrying `missingChars`, and every rejection carries a typed {@link PlateRejectionCode}
 * that D2-04 can weight its fuzzy search on.
 */

import { normalise } from './normalise.js';

/* -------------------------------------------------------------------------------------------- */
/* State codes                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * RTO state / union-territory codes, one per line — **this is the list to edit.**
 *
 * Adding a code is a single line here and nothing else: the layouts, the validator, the corrector
 * and the fixtures all read from this record. Legacy codes that still appear on the road are kept
 * alongside their replacements (`OR`/`OD`, `UA`/`UK`, `TS`/`TG`, `DN`/`DD`) because a 2004 plate is
 * still a plate.
 *
 * `BH` is deliberately **absent**: Bharat-series is not a state code, it is a literal in the middle
 * of a different layout, and `BH01AB1234` is not a registration.
 */
export const STATE_CODES: Readonly<Record<string, string>> = {
  AN: 'Andaman and Nicobar Islands',
  AP: 'Andhra Pradesh',
  AR: 'Arunachal Pradesh',
  AS: 'Assam',
  BR: 'Bihar',
  CG: 'Chhattisgarh',
  CH: 'Chandigarh',
  DD: 'Dadra and Nagar Haveli and Daman and Diu',
  DL: 'Delhi',
  DN: 'Dadra and Nagar Haveli (legacy)',
  GA: 'Goa',
  GJ: 'Gujarat',
  HP: 'Himachal Pradesh',
  HR: 'Haryana',
  JH: 'Jharkhand',
  JK: 'Jammu and Kashmir',
  KA: 'Karnataka',
  KL: 'Kerala',
  LA: 'Ladakh',
  LD: 'Lakshadweep',
  MH: 'Maharashtra',
  ML: 'Meghalaya',
  MN: 'Manipur',
  MP: 'Madhya Pradesh',
  MZ: 'Mizoram',
  NL: 'Nagaland',
  OD: 'Odisha',
  OR: 'Odisha (legacy)',
  PB: 'Punjab',
  PY: 'Puducherry',
  RJ: 'Rajasthan',
  SK: 'Sikkim',
  TN: 'Tamil Nadu',
  TR: 'Tripura',
  TS: 'Telangana',
  TG: 'Telangana (2024 onward)',
  UA: 'Uttarakhand (legacy)',
  UK: 'Uttarakhand',
  UP: 'Uttar Pradesh',
  WB: 'West Bengal',
};

/** `true` when `code` is a recognised RTO state / UT code. */
export function isStateCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(STATE_CODES, code);
}

/* -------------------------------------------------------------------------------------------- */
/* Layouts                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** The registration families this module implements. */
export const PLATE_FORMATS = [
  'standard',
  'legacy_no_series',
  'bharat_series',
  'military',
  'diplomatic',
] as const;
export type PlateFormat = (typeof PLATE_FORMATS)[number];

/** Which slot of a registration a character belongs to. Carried on every correction. */
export type PlateSlotName =
  | 'state'
  | 'rto'
  | 'series'
  | 'number'
  | 'year'
  | 'marker'
  | 'class'
  | 'serial'
  | 'check'
  | 'mission';

type SlotClass = 'alpha' | 'digit' | 'literal';

interface Slot {
  readonly name: PlateSlotName;
  readonly cls: SlotClass;
  readonly len: number;
  /** For `cls: 'literal'`, the alternatives accepted verbatim. Never corrected into. */
  readonly literals?: readonly string[];
}

interface Layout {
  readonly format: PlateFormat;
  readonly slots: readonly Slot[];
  readonly length: number;
}

function layout(format: PlateFormat, slots: readonly Slot[]): Layout {
  return { format, slots, length: slots.reduce((n, s) => n + s.len, 0) };
}

/**
 * Every concrete (fixed-length) layout, in preference order.
 *
 * Variable-length families are expanded into concrete layouts rather than matched with a regex,
 * because the corrector needs to know which slot each individual character sits in, and because a
 * fixed length makes "is this a truncated prefix?" a subtraction rather than a parse.
 */
export const LAYOUTS: readonly Layout[] = [
  // Standard: <state:2 alpha><rto:1-2 digit><series:1-3 alpha><number:4 digit>. `GJ01AB1234`.
  // Delhi's letter-suffixed RTO (`DL 1C AA 1234`) falls out of the 1-digit RTO + 3-alpha series
  // combination without a special case.
  ...[2, 1].flatMap((rto) =>
    [2, 1, 3].map((series) =>
      layout('standard', [
        { name: 'state', cls: 'alpha', len: 2 },
        { name: 'rto', cls: 'digit', len: rto },
        { name: 'series', cls: 'alpha', len: series },
        { name: 'number', cls: 'digit', len: 4 },
      ]),
    ),
  ),
  // Bharat series: <yy:2 digit>BH<number:4 digit><series:1-2 alpha>. `22BH1234AA`.
  ...[2, 1].map((series) =>
    layout('bharat_series', [
      { name: 'year', cls: 'digit', len: 2 },
      { name: 'marker', cls: 'literal', len: 2, literals: ['BH'] },
      { name: 'number', cls: 'digit', len: 4 },
      { name: 'series', cls: 'alpha', len: series },
    ]),
  ),
  // Armed forces: <prefix:2 digit><class:1 alpha><serial:6 digit><check:1 alpha>. `06B123456A`.
  layout('military', [
    { name: 'year', cls: 'digit', len: 2 },
    { name: 'class', cls: 'alpha', len: 1 },
    { name: 'serial', cls: 'digit', len: 6 },
    { name: 'check', cls: 'alpha', len: 1 },
  ]),
  // Diplomatic: <country:2-3 digit><CD|CC|UN><serial:3-4 digit>. `33CD0001`, `11UN0022`.
  ...[2, 3].flatMap((country) =>
    [4, 3].map((serial) =>
      layout('diplomatic', [
        { name: 'mission', cls: 'digit', len: country },
        { name: 'marker', cls: 'literal', len: 2, literals: ['CD', 'CC', 'UN'] },
        { name: 'serial', cls: 'digit', len: serial },
      ]),
    ),
  ),
  // Legacy, pre-series: <state:2 alpha><rto:1-2 digit><number:4 digit>. `GJ011234`.
  // Last in preference order: it is the only family with no alphabetic series, so it must never
  // win against a standard reading that fits without correction.
  ...[2, 1].map((rto) =>
    layout('legacy_no_series', [
      { name: 'state', cls: 'alpha', len: 2 },
      { name: 'rto', cls: 'digit', len: rto },
      { name: 'number', cls: 'digit', len: 4 },
    ]),
  ),
];

/** Shortest and longest complete registration this grammar accepts. */
export const MIN_PLATE_LENGTH = Math.min(...LAYOUTS.map((l) => l.length));
export const MAX_PLATE_LENGTH = Math.max(...LAYOUTS.map((l) => l.length));

/** Below this, a read carries too little structure to say anything about. */
export const MIN_EVALUABLE_LENGTH = 4;

/* -------------------------------------------------------------------------------------------- */
/* Confusions                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * Letters that a digit slot may be *corrected from*.
 *
 * This direction is safe: a letter standing where only digits are legal is a **structurally
 * impossible** read, so something is definitely wrong and the confusable digit is the best
 * available repair. D2-05 measured `0 -> D` on live output; correcting `D` back to `0` in a numeric
 * slot is exactly this direction.
 *
 * `alternatives` are the other plausible sources, recorded on the correction rather than applied,
 * so D2-04's fuzzy search can branch on them instead of re-deriving them.
 */
export const ALPHA_TO_DIGIT: Readonly<Record<string, { to: string; alternatives: string[] }>> = {
  O: { to: '0', alternatives: [] },
  D: { to: '0', alternatives: [] },
  Q: { to: '0', alternatives: [] },
  I: { to: '1', alternatives: [] },
  L: { to: '1', alternatives: [] },
  Z: { to: '2', alternatives: [] },
  A: { to: '4', alternatives: [] },
  S: { to: '5', alternatives: [] },
  G: { to: '6', alternatives: ['9'] },
  T: { to: '7', alternatives: [] },
  B: { to: '8', alternatives: ['6'] },
};

/**
 * Digits that an alpha slot may be *corrected from* — under the guard below, never freely.
 *
 * This direction is dangerous, which is why {@link fitLayout} only permits it inside the `series`
 * slot and only when that slot already contains at least one real letter. Without that guard,
 * `757508300` fits `standard` as `TS75O8300` (`7 -> T`, `5 -> S`, `0 -> O`) — a structurally
 * perfect Telangana registration, and the hoarding on cam05 becomes a watchlist hit at the highest
 * confidence in the run. `GJ3266416`, one of D2-05's deliberately-seeded non-plates, likewise
 * launders into `GJ32G6416`. Both must stay rejected, so the anchor letter is mandatory.
 */
export const DIGIT_TO_ALPHA: Readonly<Record<string, { to: string; alternatives: string[] }>> = {
  '0': { to: 'O', alternatives: ['D', 'Q'] },
  '1': { to: 'I', alternatives: ['L'] },
  '2': { to: 'Z', alternatives: [] },
  '4': { to: 'A', alternatives: [] },
  '5': { to: 'S', alternatives: [] },
  '6': { to: 'G', alternatives: [] },
  '7': { to: 'T', alternatives: [] },
  '8': { to: 'B', alternatives: [] },
};

/** Corrections above this and the read is not a plate we are repairing, it is a guess. */
export const MAX_CORRECTIONS = 2;

/* -------------------------------------------------------------------------------------------- */
/* Result types                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * Why a read is not a complete valid registration.
 *
 * **This enum is a D2-04 interface.** "Invalid" alone tells a fuzzy matcher nothing; `truncated`
 * with `missingChars: 2` tells it to search prefixes, `unknown_state_code` tells it to weight
 * positions 0-1, and `no_letters` tells it not to search at all.
 */
export const PLATE_REJECTION_CODES = [
  /** Nothing survived normalisation. */
  'empty',
  /** Shorter than {@link MIN_EVALUABLE_LENGTH}. */
  'too_short',
  /** Longer than any layout. */
  'too_long',
  /** All digits. A registration always contains letters — this is signage, a phone number, a price. */
  'no_letters',
  /** All letters. Shop fascia, a road sign (`CIRCLE`), lettering on a truck body. */
  'no_digits',
  /** Positions 0-1 are not two letters and no digit-leading layout matched its marker. */
  'no_state_code',
  /** Two letters, but not a recognised RTO code. */
  'unknown_state_code',
  /** No digits where the RTO code belongs. */
  'missing_rto_digits',
  /** The series region is not alphabetic and cannot be repaired under the correction guard. */
  'bad_series',
  /** The trailing number is the wrong length or the wrong character class. */
  'bad_number',
  /** A clean prefix of a valid registration — characters are missing from the end. */
  'truncated',
  /** More than one layout repairs the read to different strings; refusing to pick. */
  'ambiguous',
  /** Structurally unlike any registration. */
  'non_plate_shape',
] as const;
export type PlateRejectionCode = (typeof PLATE_REJECTION_CODES)[number];

export interface PlateRejection {
  readonly code: PlateRejectionCode;
  readonly message: string;
  /** 0-based index into the normalised string where the problem starts, when known. */
  readonly index: number | null;
}

export interface PlateCorrection {
  /** 0-based index into the normalised string. */
  readonly index: number;
  readonly from: string;
  readonly to: string;
  readonly slot: PlateSlotName;
  /** Other characters the source glyph is confusable with, for D2-04 to branch on. */
  readonly alternatives: readonly string[];
}

export interface PlateParts {
  readonly state: string | null;
  readonly rto: string | null;
  readonly series: string | null;
  readonly number: string | null;
}

/**
 * Three-valued, not boolean.
 *
 * - `valid` — a complete registration under some layout (possibly after correction).
 * - `partial` — a clean **prefix** of one: everything present parses, characters are missing from
 *   the end. This is the dominant outcome on the live estate and it is a usable identification.
 * - `invalid` — not a registration, and the `reasons` say why.
 */
export type PlateValidity = 'valid' | 'partial' | 'invalid';

export interface PlateValidation {
  /** The input exactly as given. */
  readonly input: string;
  /** Canonical `[A-Z0-9]` form of the input, before correction. */
  readonly normalized: string;
  /** Canonical form after slot-aware correction. Equals `normalized` when nothing was corrected. */
  readonly corrected: string;
  readonly validity: PlateValidity;
  /** `true` only for `validity === 'valid'`. The ticket's `grammar_valid`. */
  readonly grammarValid: boolean;
  /** The ticket's `grammar_corrected`. */
  readonly grammarCorrected: boolean;
  readonly corrections: readonly PlateCorrection[];
  readonly format: PlateFormat | null;
  readonly parts: PlateParts | null;
  /** `corrected.length / layout.length` of the chosen layout, `0` when nothing matched. 0..1. */
  readonly completeness: number;
  /** Characters short of a complete registration; `0` when valid, `null` when nothing matched. */
  readonly missingChars: number | null;
  /** Primary reason first. Empty only when `validity === 'valid'` with no corrections. */
  readonly reasons: readonly PlateRejection[];
}

/* -------------------------------------------------------------------------------------------- */
/* Fitting                                                                                        */
/* -------------------------------------------------------------------------------------------- */

const isAlpha = (ch: string): boolean => ch >= 'A' && ch <= 'Z';
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

interface Fit {
  readonly layout: Layout;
  readonly corrected: string;
  readonly corrections: PlateCorrection[];
  /** Characters of the layout not present in the text. `0` for a complete fit. */
  readonly missing: number;
}

/**
 * Fit `text` against one layout, either completely or as a leading prefix.
 *
 * Returns `null` when the text cannot be made to fit within {@link MAX_CORRECTIONS} corrections
 * under the asymmetric correction rule.
 */
function fitLayout(text: string, l: Layout, mode: 'full' | 'prefix'): Fit | null {
  if (mode === 'full' && text.length !== l.length) return null;
  if (mode === 'prefix' && text.length >= l.length) return null;

  const out: string[] = [];
  const corrections: PlateCorrection[] = [];
  let pos = 0;
  let slotsStarted = 0;
  let discriminatorsSeen = 0;

  for (const slot of l.slots) {
    if (pos >= text.length) break;
    const present = text.slice(pos, pos + slot.len);
    slotsStarted += 1;
    // A layout is only identifiable by its state code or its literal marker. A prefix that stops
    // inside one of those claims a format it has not established, so require them complete.
    if (slot.name === 'state' || slot.cls === 'literal') {
      if (present.length < slot.len) return null;
      discriminatorsSeen += 1;
    }

    if (slot.cls === 'literal') {
      // A marker is never corrected *into*. Without that, any four characters become a
      // Bharat-series plate and the format families stop discriminating anything.
      if (!slot.literals?.includes(present)) return null;
      out.push(present);
      pos += present.length;
      continue;
    }

    if (slot.name === 'state' && !isStateCode(present)) {
      // The state code is an enumeration, not a character class. Without this check `ZZ01AB1234`
      // fits `standard` perfectly and every two-letter OCR hallucination becomes a registration.
      return null;
    }

    const wantDigit = slot.cls === 'digit';
    // The guard that keeps hoardings out of the watchlist: a digit may only be read as a letter
    // inside the series, and only when a real letter is already sitting in that same slot.
    const seriesAnchored = slot.name === 'series' && [...present].some(isAlpha);

    for (let i = 0; i < present.length; i += 1) {
      const ch = present[i]!;
      if (wantDigit ? isDigit(ch) : isAlpha(ch)) {
        out.push(ch);
        continue;
      }
      if (slot.name === 'state') return null; // never corrected — see DIGIT_TO_ALPHA
      if (!wantDigit && !seriesAnchored) return null;

      const map = wantDigit ? ALPHA_TO_DIGIT : DIGIT_TO_ALPHA;
      const swap = map[ch];
      if (swap === undefined) return null;
      corrections.push({
        index: pos + i,
        from: ch,
        to: swap.to,
        slot: slot.name,
        alternatives: swap.alternatives,
      });
      if (corrections.length > MAX_CORRECTIONS) return null;
      out.push(swap.to);
    }
    pos += present.length;
  }

  if (pos !== text.length) return null;
  if (mode === 'prefix') {
    // A prefix must reach at least the layout's second slot in full, otherwise "GJ" and "1118" both
    // look like the beginning of something and every fragment becomes a partial identification.
    if (slotsStarted < 2) return null;
    const firstTwo = l.slots[0]!.len + l.slots[1]!.len;
    if (text.length < firstTwo) return null;
    // …and it must have established *which* format it is a prefix of. `military` has neither a
    // state code nor a marker — its discriminator is its full 10-character shape — so it is
    // prefix-ineligible by construction. Without this, `AAM412` (a D2-05 seeded non-plate) fits as
    // a truncated military registration by correcting `AA -> 44`, and `71TT` fits by `T -> 7`.
    if (discriminatorsSeen === 0) return null;
  }

  return { layout: l, corrected: out.join(''), corrections, missing: l.length - text.length };
}

/** Standard-family parts of a fitted string, for the caller and for D2-04's position weighting. */
function partsOf(fit: Fit): PlateParts {
  const parts: Record<string, string> = {};
  let pos = 0;
  for (const slot of fit.layout.slots) {
    const piece = fit.corrected.slice(pos, pos + slot.len);
    if (piece.length > 0) parts[slot.name] = piece;
    pos += slot.len;
  }
  return {
    state: parts['state'] ?? null,
    rto: parts['rto'] ?? null,
    series: parts['series'] ?? null,
    number: parts['number'] ?? parts['serial'] ?? null,
  };
}

/**
 * Choose between candidate fits.
 *
 * **Fewest corrections wins, before completeness.** On this estate truncation is the dominant error
 * mode, so a clean prefix is better evidence than a repaired full string: `GJ32DD10` fits
 * `legacy_no_series` completely as `GJ320010` with two corrections, and fits `standard` as an
 * uncorrected prefix missing two digits. The prefix is the honest reading, and it is the one that
 * matches ground truth (`GJ32D0107`).
 */
function best(fits: Fit[]): Fit | null {
  if (fits.length === 0) return null;
  const sorted = [...fits].sort(
    (a, b) =>
      a.corrections.length - b.corrections.length ||
      a.missing - b.missing ||
      LAYOUTS.indexOf(a.layout) - LAYOUTS.indexOf(b.layout),
  );
  return sorted[0]!;
}

/** `true` when two equally-cheap fits disagree about what the string should be corrected to. */
function isAmbiguous(fits: Fit[], winner: Fit): boolean {
  return fits.some(
    (f) =>
      f.corrections.length === winner.corrections.length &&
      f.missing === winner.missing &&
      f.corrected !== winner.corrected,
  );
}

/* -------------------------------------------------------------------------------------------- */
/* Diagnosis                                                                                      */
/* -------------------------------------------------------------------------------------------- */

const say = (code: PlateRejectionCode, message: string, index: number | null): PlateRejection => ({
  code,
  message,
  index,
});

/**
 * Explain a read that fitted nothing.
 *
 * Walks the standard family greedily and names the first slot that fails, because "why" is what
 * D2-04 weights its search on and what D3-06's gap analysis reports per camera.
 */
function diagnose(t: string): PlateRejection[] {
  const reasons: PlateRejection[] = [];

  if (t.length === 0) return [say('empty', 'nothing survived normalisation', null)];
  if (t.length < MIN_EVALUABLE_LENGTH) {
    reasons.push(
      say('too_short', `${t.length} characters — below the ${MIN_EVALUABLE_LENGTH} minimum`, null),
    );
  }
  if (!/[A-Z]/.test(t)) {
    reasons.push(
      say(
        'no_letters',
        'all digits — a registration always contains letters; this is signage, a phone number or a price',
        0,
      ),
    );
  }
  if (!/[0-9]/.test(t)) {
    reasons.push(say('no_digits', 'all letters — a registration always contains digits', 0));
  }
  if (t.length > MAX_PLATE_LENGTH) {
    reasons.push(
      say(
        'too_long',
        `${t.length} characters — longer than any layout (${MAX_PLATE_LENGTH})`,
        null,
      ),
    );
  }
  if (reasons.length > 0) return reasons;

  const state = t.slice(0, 2);
  if (!/^[A-Z]{2}/.test(t)) {
    return [say('no_state_code', `"${state}" is not two letters`, 0)];
  }
  if (!isStateCode(state)) {
    return [say('unknown_state_code', `"${state}" is not a recognised RTO state code`, 0)];
  }

  const rto = /^[0-9]{1,2}/.exec(t.slice(2));
  if (rto === null) {
    return [say('missing_rto_digits', `no RTO digits after "${state}"`, 2)];
  }
  const afterRto = 2 + rto[0].length;

  const series = /^[A-Z]{1,3}/.exec(t.slice(afterRto));
  if (series === null) {
    return [
      say(
        'bad_series',
        `"${t.slice(afterRto)}" is not an alphabetic series, and the digits cannot be read as letters without an anchoring letter in the slot`,
        afterRto,
      ),
    ];
  }
  const afterSeries = afterRto + series[0].length;
  const tail = t.slice(afterSeries);
  if (!/^[0-9]{1,4}$/.test(tail)) {
    return [say('bad_number', `"${tail}" is not a 1-4 digit registration number`, afterSeries)];
  }

  return [say('non_plate_shape', 'structurally unlike any registration in this grammar', null)];
}

/* -------------------------------------------------------------------------------------------- */
/* Public API                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * Validate a plate read against the Indian registration grammar.
 *
 * Normalises first (total and idempotent, so passing an already-normalised string is free), then
 * tries every layout completely, then as a truncated prefix. Never throws.
 *
 * @example
 * validate('GJO1AB1234').corrected   // 'GJ01AB1234'  (O -> 0 in the RTO slot)
 * validate('GJ35U07').validity       // 'partial'     (missingChars: 2)
 * validate('757508300').validity     // 'invalid'     (no_letters)
 */
export function validate(input: unknown): PlateValidation {
  const raw = typeof input === 'string' ? input : '';
  const normalized = normalise(input);

  const base = {
    input: raw,
    normalized,
    corrected: normalized,
    grammarValid: false,
    grammarCorrected: false,
    corrections: [] as readonly PlateCorrection[],
    format: null,
    parts: null,
    completeness: 0,
    missingChars: null,
  };

  if (normalized.length < MIN_EVALUABLE_LENGTH) {
    return { ...base, validity: 'invalid', reasons: diagnose(normalized) };
  }

  const fullFits = LAYOUTS.map((l) => fitLayout(normalized, l, 'full')).filter(
    (f): f is Fit => f !== null,
  );
  const prefixFits = LAYOUTS.map((l) => fitLayout(normalized, l, 'prefix')).filter(
    (f): f is Fit => f !== null,
  );

  const candidates = [...fullFits, ...prefixFits];
  const winner = best(candidates);

  if (winner === null) {
    return { ...base, validity: 'invalid', reasons: diagnose(normalized) };
  }

  if (isAmbiguous(candidates, winner)) {
    return {
      ...base,
      validity: 'invalid',
      reasons: [
        say(
          'ambiguous',
          'more than one layout repairs this read to a different registration; refusing to pick one',
          null,
        ),
      ],
    };
  }

  const complete = winner.missing === 0;
  const reasons: PlateRejection[] = complete
    ? []
    : [
        say(
          'truncated',
          `clean prefix of a ${winner.layout.format} registration, ${winner.missing} character(s) short`,
          normalized.length,
        ),
      ];

  return {
    input: raw,
    normalized,
    corrected: winner.corrected,
    validity: complete ? 'valid' : 'partial',
    grammarValid: complete,
    grammarCorrected: winner.corrections.length > 0,
    corrections: winner.corrections,
    format: winner.layout.format,
    parts: partsOf(winner),
    completeness: normalized.length / winner.layout.length,
    missingChars: winner.missing,
    reasons,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Confidence                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * The documented confidence rule (AC 4).
 *
 * ```
 * adjusted = raw x VALIDITY_FACTOR[validity]
 *                x CORRECTION_FACTOR ^ (number of corrections)
 *                x (NON_PLATE_FACTOR if the read has no letters or no digits at all)
 * ```
 *
 * Deliberately a flat product of independent, auditable factors rather than a tuned score. Two
 * consequences worth stating:
 *
 * - `adjusted <= raw` always, and `adjusted === raw` only for a clean, complete, uncorrected read.
 * - `NON_PLATE_FACTOR` separates *"failed the grammar"* from *"cannot possibly be a registration"*.
 *   `757508300` at 0.888 — the highest-confidence read of the whole live run, and a hoarding's
 *   phone number — lands at **0.0888**, below every legible read in the run.
 *
 * Positional detail (`completeness`, `missingChars`, `reasons`) is exposed as data rather than
 * folded in here, because D2-04 ranks on it and a single opaque number cannot be argued with.
 */
export const VALIDITY_FACTOR: Readonly<Record<PlateValidity, number>> = {
  valid: 1.0,
  partial: 0.75,
  invalid: 0.4,
};
export const CORRECTION_FACTOR = 0.9;
export const NON_PLATE_FACTOR = 0.25;

const STRUCTURAL_NON_PLATE: readonly PlateRejectionCode[] = ['no_letters', 'no_digits'];

/** Apply the rule above. Total: any non-finite or out-of-range confidence clamps into `[0, 1]`. */
export function adjustConfidence(confidence: number, v: PlateValidation): number {
  const raw = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
  let out = raw * VALIDITY_FACTOR[v.validity] * CORRECTION_FACTOR ** v.corrections.length;
  if (v.reasons.some((r) => STRUCTURAL_NON_PLATE.includes(r.code))) out *= NON_PLATE_FACTOR;
  return Math.round(out * 1e6) / 1e6;
}

/* -------------------------------------------------------------------------------------------- */
/* The per-read contract                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * What D2-01's pipeline and D2-06's alert engine consume, one object per plate read.
 *
 * `normalizedText` is **always a string** — possibly `''`, never `null`. An ungrammatical read is
 * retained, flagged and down-weighted, never dropped (AC 5), and `plate_reads.normalized_text`
 * keeps NULL for its original meaning: *not evaluated yet* (D2-01's handoff on #17).
 */
export interface PlateReadEvaluation {
  /** Canonical stored form after correction: `[A-Z0-9]`, the key D2-04 and the watchlist match on. */
  readonly normalizedText: string;
  /** Canonical form before correction, so an audit can see what the OCR actually said. */
  readonly rawNormalizedText: string;
  readonly grammarValid: boolean;
  readonly grammarCorrected: boolean;
  readonly corrections: readonly PlateCorrection[];
  readonly adjustedConfidence: number;
  readonly validity: PlateValidity;
  readonly reasons: readonly PlateRejection[];
  readonly format: PlateFormat | null;
  readonly parts: PlateParts | null;
  readonly completeness: number;
  readonly missingChars: number | null;
}

/** Normalise, validate, correct and down-weight one plate read. Pure; never throws. */
export function evaluatePlateRead(rawText: unknown, confidence: number): PlateReadEvaluation {
  const v = validate(rawText);
  return {
    normalizedText: v.corrected,
    rawNormalizedText: v.normalized,
    grammarValid: v.grammarValid,
    grammarCorrected: v.grammarCorrected,
    corrections: v.corrections,
    adjustedConfidence: adjustConfidence(confidence, v),
    validity: v.validity,
    reasons: v.reasons,
    format: v.format,
    parts: v.parts,
    completeness: v.completeness,
    missingChars: v.missingChars,
  };
}
