/**
 * D3-06 AC 5 — the coverage overlay's three states, and the rules that keep them honest.
 *
 * Mirrors `trust.test.ts`: the paint expressions must read a **property the API set**, never derive
 * a state from a number in the browser. The reason is the same one D1-06 gave for the band, and it
 * applies with more force here — the whole overlay exists to say that geometry alone does not
 * establish coverage, so a client that re-derived the state from geometry would defeat it.
 */
import { describe, expect, it } from 'vitest';
import {
  COVERAGE_STATES,
  COVERAGE_STYLE,
  countByState,
  coverageCaption,
  coverageFillExpression,
  coverageOpacityExpression,
  coverageOutlineExpression,
  EMPTY_COVERAGE,
  isCoverageState,
  type CoverageFeatureCollection,
} from './coverage';

function collection(states: string[]): CoverageFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: states.map((state, i) => ({
      type: 'Feature' as const,
      id: `c${String(i)}`,
      geometry: { type: 'Polygon', coordinates: [] },
      properties: {
        id: `c${String(i)}`,
        externalId: `GJ-${String(i)}`,
        state,
        band: state === 'trusted' ? 'trusted' : 'unscored',
        rangeM: 60,
      },
    })),
  };
}

describe('the paint expressions read the API state and derive nothing', () => {
  it('keys the fill on the `state` property', () => {
    const expr = JSON.stringify(coverageFillExpression());
    expect(expr).toContain('"state"');
    for (const state of COVERAGE_STATES) expect(expr).toContain(`"${state}"`);
  });

  it('never mentions a camera score, a threshold, or a distance', () => {
    // The client must not be able to decide "this is trusted" on its own. If a future edit tries,
    // a number appears in the expression and this fails.
    for (const expr of [
      coverageFillExpression(),
      coverageOutlineExpression(),
      coverageOpacityExpression(),
    ]) {
      const json = JSON.stringify(expr);
      expect(json).not.toContain('trust_score');
      expect(json).not.toContain('trustScore');
      expect(json).not.toMatch(/[^0-9.]70[^0-9]/);
      expect(json).not.toContain('rangeM');
    }
  });

  it('gives the uncovered state a transparent fill, because it has no geometry', () => {
    expect(COVERAGE_STYLE.uncovered.fill).toBeNull();
    expect(JSON.stringify(coverageFillExpression())).toContain('rgba(0,0,0,0)');
    expect(COVERAGE_STYLE.uncovered.opacity).toBe(0);
  });

  it('gives trusted and untrusted visibly different fills', () => {
    expect(COVERAGE_STYLE.trusted.fill).not.toBe(COVERAGE_STYLE.untrusted.fill);
    expect(COVERAGE_STYLE.trusted.outline).not.toBe(COVERAGE_STYLE.untrusted.outline);
  });

  it('covers every state with a fill, an outline and an opacity, with no gaps', () => {
    for (const expr of [
      coverageFillExpression(),
      coverageOutlineExpression(),
      coverageOpacityExpression(),
    ]) {
      // ['match', ['get','state'], k, v, k, v, k, v, fallback]
      expect(expr).toHaveLength(2 + COVERAGE_STATES.length * 2 + 1);
    }
  });
});

describe('the legend says what a colour asserts, not just what it is', () => {
  it('gives every state a label and a meaning', () => {
    for (const state of COVERAGE_STATES) {
      expect(COVERAGE_STYLE[state].label).not.toBe('');
      expect(COVERAGE_STYLE[state].meaning.length).toBeGreaterThan(40);
    }
  });

  it('refuses to let untrusted read as "slightly worse than trusted"', () => {
    const meaning = COVERAGE_STYLE.untrusted.meaning;
    // Never probed is folded into this state geometrically, so the wording has to name it.
    expect(meaning).toContain('never been probed');
    expect(meaning).toContain('false assurance');
    // And it has to say what a conventional map would have done, which is the whole argument.
    expect(meaning).toContain('same colour as trusted');
  });

  it('explains that uncovered is drawn as absence rather than as a layer', () => {
    expect(COVERAGE_STYLE.uncovered.meaning).toContain('absence of a cell');
  });
});

describe('counts and caption', () => {
  it('counts by state and ignores anything it does not recognise', () => {
    const counts = countByState(collection(['trusted', 'untrusted', 'untrusted', 'nonsense']));
    expect(counts).toEqual({ trusted: 1, untrusted: 2, uncovered: 0 });
  });

  it('tells an operator what to run when there are no cells at all', () => {
    expect(coverageCaption(EMPTY_COVERAGE)).toContain('report:gap-analysis');
  });

  it('names the all-untrusted case as the finding rather than leaving it looking broken', () => {
    const caption = coverageCaption(collection(['untrusted', 'untrusted']));
    expect(caption).toContain('2 of 2');
    expect(caption).toContain('nobody has verified');
    // The sentence a reviewer needs: this is what a normal coverage map would have shown green.
    expect(caption).toContain('amber');
  });

  it('reports both counts when the estate is mixed', () => {
    const caption = coverageCaption(collection(['trusted', 'untrusted', 'untrusted']));
    expect(caption).toContain('1 trusted and 2 untrusted');
  });

  it('narrows a state string', () => {
    expect(isCoverageState('trusted')).toBe(true);
    expect(isCoverageState('unscored')).toBe(false);
  });
});
