/**
 * "Trust colouring matches the API's band exactly."
 *
 * The way this criterion fails is not a wrong hex code — it is a client that recomputes the band
 * from the score. D1-06's handoff: an unreachable camera **keeps its last good score**, so
 * `trustScore >= 70` paints a camera that went dark yesterday green. The tests below therefore
 * check two different things:
 *
 *  1. the mapping band → colour is total and injective enough to be readable, and
 *  2. **no numeric threshold exists anywhere in the paint expressions** — which is the property
 *     that keeps rule 1 true after somebody edits this file in six months.
 */
import { describe, expect, it } from 'vitest';
import {
  BAND_KEYS,
  BAND_STYLE,
  CATALOGUE_STATUS_CHIP,
  HEALTH_STATUS_CHIP,
  TRUST_BANDS,
  bandFillExpression,
  bandKeyOf,
  bandStrokeExpression,
  bandStrokeWidthExpression,
  bandStyleOf,
  isBandKey,
} from './trust';

describe('the band vocabulary mirrors the API', () => {
  it('carries the four bands the API resolves plus the never-probed case', () => {
    expect([...TRUST_BANDS]).toEqual(['trusted', 'degraded', 'untrusted', 'dead']);
    expect([...BAND_KEYS]).toEqual(['trusted', 'degraded', 'untrusted', 'dead', 'unscored']);
  });

  it('maps null to `unscored` and nothing else', () => {
    expect(bandKeyOf(null)).toBe('unscored');
    expect(bandKeyOf(undefined)).toBe('unscored');
    for (const band of TRUST_BANDS) expect(bandKeyOf(band)).toBe(band);
  });

  it('rejects a value that is not a band', () => {
    expect(isBandKey('trusted')).toBe(true);
    expect(isBandKey('unscored')).toBe(true);
    expect(isBandKey('online')).toBe(false);
    expect(isBandKey('absent')).toBe(false);
  });
});

describe('never-probed is rendered as its own thing', () => {
  it('is a hollow ring, not a shade of the bad colour', () => {
    // D1-02: "The map must render *unknown* differently from *low*." A null fill is the ring.
    expect(BAND_STYLE.unscored.fill).toBeNull();
    expect(BAND_STYLE.untrusted.fill).not.toBeNull();
    expect(BAND_STYLE.unscored.stroke).not.toBe(BAND_STYLE.untrusted.stroke);
  });

  it('draws a wider stroke than a scored pin, so shape distinguishes it as well as colour', () => {
    const widths = bandStrokeWidthExpression();
    expect(widths[0]).toBe('match');
    expect(widths).toContain('unscored');
  });
});

describe('every band has a distinct, complete style', () => {
  it.each(BAND_KEYS)('%s has a label, a meaning and a chip class', (key) => {
    const style = BAND_STYLE[key];
    expect(style.label.length).toBeGreaterThan(0);
    // The legend explains what the colour *asserts*; a colour with no sentence beside it lies.
    expect(style.meaning.length).toBeGreaterThan(20);
    expect(style.chip).toContain('border-');
  });

  it('gives no two bands the same fill', () => {
    const fills = BAND_KEYS.map((k) => BAND_STYLE[k].fill).filter((f) => f !== null);
    expect(new Set(fills).size).toBe(fills.length);
  });

  it('resolves a style for a null band without throwing', () => {
    expect(bandStyleOf(null)).toBe(BAND_STYLE.unscored);
    expect(bandStyleOf('dead')).toBe(BAND_STYLE.dead);
  });
});

describe('the paint expressions contain no threshold — the rule that matters', () => {
  const expressions = {
    fill: bandFillExpression(),
    stroke: bandStrokeExpression(),
    strokeWidth: bandStrokeWidthExpression(),
  };

  it.each(Object.entries(expressions))('%s keys off the API band, not the score', (_name, expr) => {
    const json = JSON.stringify(expr);
    expect(json).toContain('"band"');
    // The two numbers that would mean somebody re-derived the band client-side.
    expect(json).not.toContain('trustScore');
    expect(json).not.toMatch(/\b70\b/);
    expect(json).not.toMatch(/\b40\b/);
    expect(json).not.toContain('>=');
    expect(json).not.toContain('step');
  });

  it('is a total match over the five keys with a fallback', () => {
    const fill = bandFillExpression();
    expect(fill[0]).toBe('match');
    expect(fill[1]).toEqual(['get', 'band']);
    for (const key of BAND_KEYS) expect(fill).toContain(key);
    // `match` needs an odd tail: 2 head + 2 per key + 1 default.
    expect(fill.length).toBe(2 + BAND_KEYS.length * 2 + 1);
  });

  it('paints the unscored fill fully transparent so the ring shows through', () => {
    const fill = bandFillExpression();
    expect(fill[fill.indexOf('unscored') + 1]).toBe('rgba(0,0,0,0)');
  });
});

describe('presence and health are two badges, never one', () => {
  // D1-04: "`catalogue_status` is presence; `status` is health. Independent by design … Do not
  // merge them into one UI badge."
  it('styles catalogue presence separately from measured health', () => {
    expect(Object.keys(CATALOGUE_STATUS_CHIP).sort()).toEqual(['absent', 'active']);
    expect(Object.keys(HEALTH_STATUS_CHIP).sort()).toEqual([
      'degraded',
      'offline',
      'online',
      'unknown',
    ]);
  });

  it('does not share a value between the two vocabularies', () => {
    const overlap = Object.keys(CATALOGUE_STATUS_CHIP).filter((k) => k in HEALTH_STATUS_CHIP);
    expect(overlap).toEqual([]);
  });

  it('gives catalogue `absent` and health `offline` visibly different colours', () => {
    expect(CATALOGUE_STATUS_CHIP['absent']).not.toBe(HEALTH_STATUS_CHIP['offline']);
  });
});
