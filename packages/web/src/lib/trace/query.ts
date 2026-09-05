/**
 * The trace screen's URL contract (D2-08).
 *
 * `/trace?plate=GJ01AB1234&from=…&to=…&min_confidence=0.4&seq=3` is the whole screen state, which
 * is what makes **"trace this vehicle"** from an alert row a plain link rather than a bespoke
 * hand-off: D2-07's alert queue only has to build this URL. It is also what makes a trace
 * shareable — an officer pastes the address into a case note and a colleague sees the same route,
 * the same window, the same confidence floor and the same selected sighting.
 *
 * Pure and symmetric on purpose: `parse(toSearchParams(state))` must return `state`, and a test
 * asserts it. Registry's `query.ts` is the pattern.
 */

export interface TraceQueryState {
  plate: string;
  /**
   * Why this search is being run (D3-04). Carried in the URL like everything else on this screen,
   * because a shared trace link has to carry the reason it was run, not just the registration.
   *
   * The API rejects a trace with no purpose, server-side, so this being empty is a real state the
   * screen renders rather than an error it reports: the officer states a reason, and it is written
   * into the audit chain against their badge.
   */
  purpose: string;
  /** The case or FIR this belongs to, when there is one. Mandatory only for an export. */
  caseRef: string | null;
  from: string | null;
  to: string | null;
  /** Floor on link confidence, `[0,1]`. */
  minConfidence: number;
  /** Weighted-distance ceiling handed to D2-04's matcher. 2 is its measured knee. */
  maxDistance: number;
  /**
   * Include vehicle appearance (re-ID) links (D3-03). **Default `false`.**
   *
   * In the URL like everything else, so the evidentiary standard a trace was run under travels with
   * the link. A colleague opening a shared trace sees the same standard, not a different one
   * because their own default differed.
   *
   * Off by default because held-out precision measured **0.761**, below D3-03's 0.9 bar — roughly
   * one appearance link in four is wrong. The officer chooses; the screen does not choose for them.
   */
  includeReid: boolean;
  /** The selected sighting's `seq`, or `null`. Drives the map highlight and the scrubber. */
  seq: number | null;
}

export const DEFAULT_MIN_CONFIDENCE = 0;
export const DEFAULT_MAX_DISTANCE = 2;

export const EMPTY_TRACE_QUERY: TraceQueryState = {
  plate: '',
  purpose: '',
  caseRef: null,
  from: null,
  to: null,
  minConfidence: DEFAULT_MIN_CONFIDENCE,
  maxDistance: DEFAULT_MAX_DISTANCE,
  includeReid: false,
  seq: null,
};

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function read(source: ParamSource, key: string): string | null {
  if (source instanceof URLSearchParams) return source.get(key);
  const value = source[key];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** An ISO instant, or `null`. A malformed date is dropped rather than thrown — it came from a URL. */
function readInstant(source: ParamSource, key: string): string | null {
  const raw = read(source, key);
  if (raw === null || raw === '') return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function readNumber(
  source: ParamSource,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = read(source, key);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function parseTraceQuery(source: ParamSource): TraceQueryState {
  const seqRaw = read(source, 'seq');
  const seq = seqRaw === null || seqRaw === '' ? null : Number(seqRaw);
  return {
    // Uppercased and stripped of spaces here as well as on the server: the address bar is the
    // first thing an officer edits by hand, and `gj01 ab 1234` must behave like the button did.
    plate: (read(source, 'plate') ?? '').replace(/\s+/g, '').toUpperCase().slice(0, 24),
    purpose: (read(source, 'purpose') ?? '').trim().slice(0, 500),
    caseRef: (read(source, 'case_ref') ?? '').trim() || null,
    from: readInstant(source, 'from'),
    to: readInstant(source, 'to'),
    minConfidence: readNumber(source, 'min_confidence', DEFAULT_MIN_CONFIDENCE, 0, 1),
    maxDistance: readNumber(source, 'max_distance', DEFAULT_MAX_DISTANCE, 0, 6),
    // Only the literal string wins. `?include_reid=false` must not switch the feature on, which is
    // exactly the `z.coerce.boolean()` trap the API's `z.stringbool()` avoids on the same parameter.
    includeReid: read(source, 'include_reid') === 'true',
    seq: seq !== null && Number.isInteger(seq) && seq > 0 ? seq : null,
  };
}

/** Only non-default values are written, so a plain trace link stays short and readable. */
export function toSearchParams(state: TraceQueryState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.plate !== '') params.set('plate', state.plate);
  if (state.purpose !== '') params.set('purpose', state.purpose);
  if (state.caseRef !== null && state.caseRef !== '') params.set('case_ref', state.caseRef);
  if (state.from !== null) params.set('from', state.from);
  if (state.to !== null) params.set('to', state.to);
  if (state.minConfidence !== DEFAULT_MIN_CONFIDENCE) {
    params.set('min_confidence', String(state.minConfidence));
  }
  if (state.maxDistance !== DEFAULT_MAX_DISTANCE) {
    params.set('max_distance', String(state.maxDistance));
  }
  if (state.includeReid) params.set('include_reid', 'true');
  if (state.seq !== null) params.set('seq', String(state.seq));
  return params;
}

/**
 * The href D2-07's alert queue puts behind "trace this vehicle".
 *
 * `seq` is deliberately not carried: an alert names a vehicle and a moment, not a sighting in a
 * trace that has not been run yet.
 *
 * Neither is a **purpose**, and that is the point of purpose binding (D3-04): a link cannot state
 * why a search is being run — only the officer running it can. The link lands on `/trace` with the
 * registration and the window filled in and the purpose field empty and waiting, and nothing is
 * searched until it is answered.
 */
export function traceHref(input: {
  plate: string;
  from?: string | null;
  to?: string | null;
  minConfidence?: number;
}): string {
  const params = toSearchParams({
    ...EMPTY_TRACE_QUERY,
    plate: input.plate.replace(/\s+/g, '').toUpperCase(),
    from: input.from ?? null,
    to: input.to ?? null,
    minConfidence: input.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
  });
  const query = params.toString();
  return query === '' ? '/trace' : `/trace?${query}`;
}

/** The query string the trace API takes, built from screen state. */
export function toTraceApiQuery(
  state: TraceQueryState,
  options: { reconstruct?: boolean } = {},
): {
  plate: string;
  purpose: string;
  min_confidence: number;
  max_distance: number;
  case_ref?: string;
  reconstruct: string;
  include_reid: string;
  from?: string;
  to?: string;
} {
  return {
    plate: state.plate,
    purpose: state.purpose,
    min_confidence: state.minConfidence,
    max_distance: state.maxDistance,
    ...(state.caseRef !== null && state.caseRef !== '' ? { case_ref: state.caseRef } : {}),
    // D3-01. Always on from the *screen*: the observed-vs-inferred distinction is not a user
    // preference, and a trace screen with a mode that draws one undifferentiated line is the
    // failure the whole feature exists to prevent. Off by default everywhere else, because the CSV
    // and PDF exports render D2-08's gap list and would otherwise pay for an OSRM query per hop
    // to produce a route nothing in them prints.
    //
    // A **string**, not a boolean: the API parses it with `z.stringbool()` and the generated
    // OpenAPI type is `string`, so the wire value is what this function has to speak.
    reconstruct: options.reconstruct === true ? 'true' : 'false',
    // D3-03. A string for the same `z.stringbool()` reason as `reconstruct` above. The server has
    // the second veto: `REID_ENABLED` must also be true, and the response's `reid.enabled` says
    // whether it was — so the screen can show "asked for, not available" rather than a silent
    // plate-only result under a switch that looks on.
    include_reid: state.includeReid ? 'true' : 'false',
    ...(state.from !== null ? { from: state.from } : {}),
    ...(state.to !== null ? { to: state.to } : {}),
  };
}

/** The API refuses anything shorter, so the screen must not send it and must say why. */
export const MIN_PURPOSE_LENGTH = 3;

export function purposeIsStated(state: TraceQueryState): boolean {
  return state.purpose.trim().length >= MIN_PURPOSE_LENGTH;
}
