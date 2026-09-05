/**
 * What the alert queue is allowed to claim (D2-07, AC 2 and AC 7).
 *
 * These are the tests that stop the screen overclaiming, so they are written against the **real
 * measured payloads** this estate produces rather than against convenient invented ones:
 *
 *   - `GJ35U07 → GJ35U0779` at weighted distance **0.70**, the fuzzy alert D2-06 measured;
 *   - `44671`, an exact string match on an OCR fragment that is not a registration at all — five of
 *     the seven alerts in the queue today are of this shape;
 *   - `cropUri: null`, which is true of all 28,438 sightings in the database.
 */
import { describe, expect, it } from 'vitest';
import {
  MATCH_STYLE,
  SEVERITY_STYLE,
  STRENGTH_COPY,
  cropState,
  distanceWasRounded,
  explainedNull,
  formatAge,
  formatDistance,
  formatScore,
  readability,
  sightingSentence,
  traceWindow,
} from './present';

describe('AC 7 — fuzzy and exact are unmistakable, and distance is continuous', () => {
  it('renders the measured 0.70 as 0.70, never as "1 character"', () => {
    expect(formatDistance(0.7)).toBe('0.70');
    expect(formatDistance(0.55)).toBe('0.55');
    expect(formatDistance(1.925)).toBe('1.93');
    expect(formatDistance(0)).toBe('0.00');
  });

  it('admits when it rounded', () => {
    expect(distanceWasRounded(1.925)).toBe(true);
    expect(distanceWasRounded(0.7)).toBe(false);
    expect(distanceWasRounded(0.55)).toBe(false);
  });

  it('separates fuzzy from exact by colour, by border and by word — not by colour alone', () => {
    expect(MATCH_STYLE.exact.chip).not.toBe(MATCH_STYLE.fuzzy.chip);
    expect(MATCH_STYLE.exact.border).not.toBe(MATCH_STYLE.fuzzy.border);
    expect(MATCH_STYLE.exact.short).not.toBe(MATCH_STYLE.fuzzy.short);
    // The word survives a monochrome printout and a colour-blind reader; the colour does not.
    expect(MATCH_STYLE.fuzzy.short).toBe('FUZZY');
    expect(MATCH_STYLE.fuzzy.border).toContain('dashed');
  });

  it('says in words that a fuzzy match is not an identification', () => {
    expect(MATCH_STYLE.fuzzy.caution.toLowerCase()).toContain('not an identification');
    // And an exact match on this estate is a string match, which is not the same as a vehicle.
    expect(MATCH_STYLE.exact.caution.toLowerCase()).toContain('not a vehicle');
  });

  it('keeps D2-08 s colour vocabulary — sky for exact, amber for fuzzy', () => {
    expect(MATCH_STYLE.exact.chip).toContain('sky');
    expect(MATCH_STYLE.fuzzy.chip).toContain('amber');
  });

  it('gives every severity a distinct rail, including low', () => {
    const rails = Object.values(SEVERITY_STYLE).map((s) => s.rail);
    expect(new Set(rails).size).toBe(rails.length);
  });

  it('leads with a word for every identification strength', () => {
    expect(STRENGTH_COPY.confirmed.label).toBe('Confirmed');
    expect(STRENGTH_COPY.weak.means.toLowerCase()).toContain('does not support an identification');
  });
});

describe('the verdict "this is not identifiable" is reachable without a click', () => {
  it('calls an invalid read what it is — the shape of 5 of the 7 alerts in the queue today', () => {
    const verdict = readability({
      validity: 'invalid',
      grammarValid: false,
      observedPlate: '44671',
      watchlistValue: '44671',
      missingChars: null,
      rejectionCodes: ['too_short'],
    });
    expect(verdict.kind).toBe('not-a-registration');
    expect(verdict.unidentifiable).toBe(true);
    expect(verdict.headline).toBe('Not a registration');
    expect(verdict.detail).toContain('matched a watchlist string, not a vehicle');
  });

  it('names how short a partial read is — the measured GJ35U07 case', () => {
    const verdict = readability({
      validity: 'partial',
      grammarValid: false,
      observedPlate: 'GJ35U07',
      watchlistValue: 'GJ35U0779',
      missingChars: 2,
      rejectionCodes: ['truncated'],
    });
    expect(verdict.kind).toBe('fragment');
    expect(verdict.headline).toBe('Partial read — 2 characters short');
    expect(verdict.detail).toContain('More than one vehicle can carry this prefix');
    // A fragment is a lead, not a non-identification: the operator still has work to do.
    expect(verdict.unidentifiable).toBe(false);
  });

  it('singularises one missing character', () => {
    expect(
      readability({
        validity: 'partial',
        grammarValid: false,
        observedPlate: 'GJ01AB123',
        watchlistValue: 'GJ01AB1234',
        missingChars: 1,
        rejectionCodes: ['truncated'],
      }).headline,
    ).toBe('Partial read — 1 character short');
  });

  it('reserves the confident wording for a complete grammar-valid registration', () => {
    const verdict = readability({
      validity: 'valid',
      grammarValid: true,
      observedPlate: 'GJ01AB1234',
      watchlistValue: 'GJ01AB1234',
      missingChars: 0,
      rejectionCodes: [],
    });
    expect(verdict.kind).toBe('registration');
    expect(verdict.unidentifiable).toBe(false);
  });

  it('does not claim a registration when the grammar validator refused it, whatever the validity', () => {
    expect(
      readability({
        validity: 'valid',
        grammarValid: false,
        observedPlate: 'GJ01AB1234',
        watchlistValue: 'GJ01AB1234',
        missingChars: 0,
        rejectionCodes: [],
      }).kind,
    ).toBe('fragment');
  });
});

describe('AC 2 — the crop degrades gracefully, and says which failure it hit', () => {
  it('shows the image when there is one', () => {
    expect(cropState({ cropUri: 's3://evidence/a.jpg', cropUrl: 'https://x/a.jpg' })).toEqual({
      kind: 'image',
      url: 'https://x/a.jpg',
    });
  });

  it('says "no crop stored" — the state of all 28,438 sightings in this database', () => {
    const state = cropState({ cropUri: null, cropUrl: null });
    expect(state.kind).toBe('none');
    expect(state.kind === 'none' && state.reason).toContain('No crop was stored');
  });

  it('distinguishes a missing object store from a missing crop', () => {
    const state = cropState({ cropUri: 's3://evidence/a.jpg', cropUrl: null });
    expect(state.kind).toBe('unconfigured');
    expect(state.kind === 'unconfigured' && state.reason).toContain('no object store');
  });

  it('names the 900 s expiry when the signed link is dead, and says what fixes it', () => {
    const state = cropState({ cropUri: 's3://e/a.jpg', cropUrl: 'https://x/a.jpg' }, true);
    expect(state.kind).toBe('broken');
    expect(state.kind === 'broken' && state.reason).toContain('900');
    expect(state.kind === 'broken' && state.reason).toContain('Refresh');
  });
});

describe('an explained null is never rendered as a zero', () => {
  it('says "never probed" rather than 0 for an unmeasured trust score', () => {
    expect(explainedNull(null, 'never probed')).toBe('never probed');
    expect(explainedNull(0, 'never probed')).toBe('0');
    expect(explainedNull(74.6, 'never probed')).toBe('75');
  });
});

describe('scores are labelled percentages, never bare floats', () => {
  it('rounds the measured combined confidence to a percentage', () => {
    expect(formatScore(0.34515)).toBe('35%');
    expect(formatScore(0.073)).toBe('7%');
    expect(formatScore(1)).toBe('100%');
  });
});

describe('the three timestamps read as one sentence', () => {
  it('says "seen once" when there is nothing to collapse', () => {
    expect(
      sightingSentence({
        ts: '2026-09-05T00:00:51.970Z',
        lastSeenAt: '2026-09-05T00:00:51.970Z',
        sightingCount: 1,
      }),
    ).toContain('seen once');
  });

  it('reports a repeat count — the loitering signal', () => {
    const sentence = sightingSentence({
      ts: '2026-09-05T00:00:51.970Z',
      lastSeenAt: '2026-09-05T00:19:00.000Z',
      sightingCount: 23,
    });
    expect(sentence).toContain('23 times');
    expect(sentence).toContain('first');
    expect(sentence).toContain('again');
  });

  it('ages a row in the unit an operator thinks in', () => {
    const now = Date.parse('2026-09-05T01:00:00.000Z');
    expect(formatAge('2026-09-05T00:59:56.000Z', now)).toBe('4 s');
    expect(formatAge('2026-09-05T00:48:00.000Z', now)).toBe('12 m');
    expect(formatAge('2026-09-04T22:00:00.000Z', now)).toBe('3 h');
    expect(formatAge('2026-09-03T01:00:00.000Z', now)).toBe('2 d');
    expect(formatAge('not a date', now)).toBe('—');
  });

  it('opens a trace an hour either side of the alert, not the whole day', () => {
    const window = traceWindow({
      ts: '2026-09-05T00:30:00.000Z',
      lastSeenAt: '2026-09-05T00:40:00.000Z',
    });
    expect(window.from).toBe('2026-09-04T23:30:00.000Z');
    expect(window.to).toBe('2026-09-05T01:40:00.000Z');
  });
});
