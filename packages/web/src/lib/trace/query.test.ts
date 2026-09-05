/**
 * D2-08 — the trace screen's URL contract.
 *
 * The URL is the deep link an alert row uses and the thing an officer pastes into a case note, so
 * round-tripping is the property that matters: whatever the screen puts in the address bar must
 * come back as the same screen.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_DISTANCE,
  DEFAULT_MIN_CONFIDENCE,
  EMPTY_TRACE_QUERY,
  parseTraceQuery,
  toSearchParams,
  purposeIsStated,
  toTraceApiQuery,
  traceHref,
  type TraceQueryState,
} from './query';

const state = (over: Partial<TraceQueryState> = {}): TraceQueryState => ({
  ...EMPTY_TRACE_QUERY,
  plate: 'GJ01AB1234',
  ...over,
});

describe('parse ∘ serialise is the identity', () => {
  for (const [name, value] of [
    ['a bare plate', state()],
    ['a window', state({ from: '2026-05-10T09:00:00.000Z', to: '2026-05-10T10:00:00.000Z' })],
    ['a confidence floor', state({ minConfidence: 0.45 })],
    ['a stated purpose', state({ purpose: 'FIR follow-up: vehicle movement' })],
    [
      'a purpose and a case reference',
      state({ purpose: 'theft enquiry', caseRef: 'FIR/2026/00123' }),
    ],
    ['a widened matcher', state({ maxDistance: 3 })],
    ['a selected sighting', state({ seq: 4 })],
    [
      'everything at once',
      state({ from: '2026-05-10T09:00:00.000Z', minConfidence: 0.6, maxDistance: 1, seq: 2 }),
    ],
    ['an empty screen', EMPTY_TRACE_QUERY],
  ] as [string, TraceQueryState][]) {
    it(name, () => {
      expect(parseTraceQuery(toSearchParams(value))).toEqual(value);
    });
  }
});

describe('defaults stay out of the URL', () => {
  it('a plain trace link is just the plate', () => {
    expect(toSearchParams(state()).toString()).toBe('plate=GJ01AB1234');
  });

  it('the defaults are the API defaults, so an absent parameter never changes the answer', () => {
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0);
    expect(DEFAULT_MAX_DISTANCE).toBe(2);
  });
});

describe('a URL is user input', () => {
  it('a hand-typed plate is normalised the way the button would have', () => {
    expect(parseTraceQuery({ plate: 'gj01 ab 1234' }).plate).toBe('GJ01AB1234');
  });

  it('a malformed date is dropped rather than thrown', () => {
    expect(parseTraceQuery({ from: 'yesterday' }).from).toBeNull();
  });

  it('an out-of-range confidence is clamped, not rejected', () => {
    expect(parseTraceQuery({ min_confidence: '9' }).minConfidence).toBe(1);
    expect(parseTraceQuery({ min_confidence: '-3' }).minConfidence).toBe(0);
    expect(parseTraceQuery({ min_confidence: 'x' }).minConfidence).toBe(0);
  });

  it('a non-positive or fractional seq is no selection at all', () => {
    expect(parseTraceQuery({ seq: '0' }).seq).toBeNull();
    expect(parseTraceQuery({ seq: '1.5' }).seq).toBeNull();
    expect(parseTraceQuery({ seq: '3' }).seq).toBe(3);
  });
});

describe('purpose binding — a link cannot state a reason (D3-04)', () => {
  it('a purpose shorter than the API accepts is not a stated purpose', () => {
    expect(purposeIsStated(state({ purpose: '' }))).toBe(false);
    expect(purposeIsStated(state({ purpose: '  ' }))).toBe(false);
    expect(purposeIsStated(state({ purpose: 'ab' }))).toBe(false);
    expect(purposeIsStated(state({ purpose: 'FIR follow-up' }))).toBe(true);
  });

  it("an alert's trace link carries no purpose, so the screen has to ask for one", () => {
    const href = traceHref({ plate: 'GJ01AB1234', from: '2026-05-10T09:00:00.000Z' });
    expect(href).not.toContain('purpose');
    expect(purposeIsStated(parseTraceQuery(new URLSearchParams(href.split('?')[1] ?? '')))).toBe(
      false,
    );
  });
});

describe('traceHref — what an alert row links to', () => {
  it('carries the plate and the time window, and no pre-selected sighting', () => {
    const href = traceHref({
      plate: 'gj 01 ab 1234',
      from: '2026-05-10T09:00:00.000Z',
      to: '2026-05-10T10:00:00.000Z',
    });
    const parsed = parseTraceQuery(new URLSearchParams(href.split('?')[1] ?? ''));
    expect(parsed.plate).toBe('GJ01AB1234');
    expect(parsed.from).toBe('2026-05-10T09:00:00.000Z');
    expect(parsed.to).toBe('2026-05-10T10:00:00.000Z');
    expect(parsed.seq).toBeNull();
  });

  it('degrades to a bare /trace with nothing to carry', () => {
    expect(traceHref({ plate: '' })).toBe('/trace');
  });
});

describe('toTraceApiQuery', () => {
  it('omits an absent window rather than sending null, which the API would reject', () => {
    expect(toTraceApiQuery(state())).toEqual({
      plate: 'GJ01AB1234',
      // Always sent, even empty: the API is the side that rejects a search with no stated purpose
      // (D3-04), and a client that quietly omitted the field would be deciding that for it.
      purpose: '',
      min_confidence: 0,
      max_distance: 2,
      reconstruct: 'false',
    });
  });

  it('carries the stated purpose and the case reference when there is one', () => {
    expect(
      toTraceApiQuery(state({ purpose: 'FIR follow-up', caseRef: 'FIR/2026/00123' })),
    ).toMatchObject({ purpose: 'FIR follow-up', case_ref: 'FIR/2026/00123' });
  });

  it('omits an absent case reference rather than sending null', () => {
    expect(toTraceApiQuery(state({ purpose: 'x' }))).not.toHaveProperty('case_ref');
  });

  it('asks for a route reconstruction only when told to, and speaks the wire type', () => {
    // The API parses this with `z.stringbool()`, so the value has to be the string 'true'. Sending
    // a boolean here would be coerced by `z.coerce.boolean()` semantics somewhere downstream and
    // `'false'` would switch the feature ON — the reason D3-01 did not use `coerce`.
    expect(toTraceApiQuery(state(), { reconstruct: true }).reconstruct).toBe('true');
    expect(toTraceApiQuery(state(), { reconstruct: false }).reconstruct).toBe('false');
    expect(toTraceApiQuery(state()).reconstruct).toBe('false');
  });

  it('passes the window through when it is set', () => {
    expect(toTraceApiQuery(state({ from: '2026-05-10T09:00:00.000Z' }))).toMatchObject({
      from: '2026-05-10T09:00:00.000Z',
    });
  });
});
