/**
 * The deck must not disagree with the report a judge can open.
 *
 * D4-04's AC 6 is *"measured ANPR accuracy identical to `submission/govt-feed-output-report.pdf`"*,
 * and the failure mode it guards against is quiet: two documents generated weeks apart, each
 * internally consistent, differing in one figure that a scorer notices and nobody else does.
 *
 * Comparing them by eye is exactly the check that stops happening under deadline, so it is asserted
 * here instead — the deck's constant against the bytes of D4-03's generated PDF.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEASURED_ANPR } from './solution-deck.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const REPORT_PDF = path.join(REPO_ROOT, 'submission', 'govt-feed-output-report.pdf');
const DECK_PDF = path.join(REPO_ROOT, 'submission', 'saakshi-solution-deck.pdf');

/**
 * Text drawn by `pdf.ts` appears in the content stream as `(…) Tj`, uncompressed and Latin-1.
 *
 * That is only true because this writer does not deflate its streams — which is a documented
 * decision, not an accident, and is what makes the generated artefacts greppable at all.
 */
function pdfText(file: string): string {
  const raw = readFileSync(file).toString('latin1');
  return [...raw.matchAll(/\((.*?)\)\s*Tj/g)]
    .map((m) => (m[1] ?? '').replace(/\\([()\\])/g, '$1'))
    .join(' ');
}

describe('the deck and the output report state the same accuracy (AC 6)', () => {
  it('has both artefacts committed', () => {
    expect(existsSync(DECK_PDF), `${DECK_PDF} — run npm run deck:build`).toBe(true);
    expect(existsSync(REPORT_PDF), `${REPORT_PDF} — run npm run report:anpr-output`).toBe(true);
  });

  it('prints every accuracy figure in the deck', () => {
    if (!existsSync(DECK_PDF)) return expect(existsSync(DECK_PDF)).toBe(false);
    const deck = pdfText(DECK_PDF);
    for (const value of [
      MEASURED_ANPR.exactReadRecall,
      MEASURED_ANPR.precision,
      MEASURED_ANPR.plateDetectionRecall,
      MEASURED_ANPR.characterAccuracy,
      MEASURED_ANPR.legiblePlates,
    ]) {
      // Compare on digits and letters only: the deck renders an en dash where the report renders a
      // hyphen, and a failure about punctuation would be noise around the claim being tested.
      const needle = value.replace(/[^0-9a-z%]/gi, '');
      expect(deck.replace(/[^0-9a-z%]/gi, ''), `deck is missing "${value}"`).toContain(needle);
    }
  });

  it('states the same figures in the output report, so the two cannot drift', () => {
    if (!existsSync(REPORT_PDF)) return expect(existsSync(REPORT_PDF)).toBe(false);
    const report = pdfText(REPORT_PDF).replace(/[^0-9a-z%]/gi, '');
    for (const value of [
      MEASURED_ANPR.exactReadRecall,
      MEASURED_ANPR.precision,
      MEASURED_ANPR.plateDetectionRecall,
      MEASURED_ANPR.characterAccuracy,
      MEASURED_ANPR.legiblePlates,
    ]) {
      expect(report, `report is missing "${value}"`).toContain(value.replace(/[^0-9a-z%]/gi, ''));
    }
  });

  it('reports the >90% target as a miss in both, rather than omitting it', () => {
    if (!existsSync(DECK_PDF) || !existsSync(REPORT_PDF)) return;
    expect(pdfText(DECK_PDF)).toContain('MISSES');
    expect(pdfText(REPORT_PDF)).toContain('MISSES');
  });
});

describe('the deck stays within its stated limits', () => {
  it('is at most 20 slides', () => {
    if (!existsSync(DECK_PDF)) return expect(existsSync(DECK_PDF)).toBe(false);
    const pages = readFileSync(DECK_PDF).toString('latin1').split('/Type /Page ').length - 1;
    expect(pages).toBeGreaterThan(0);
    expect(pages).toBeLessThanOrEqual(20);
  });

  it('labels all ten mandatory design dimensions so a scorer can find them', () => {
    if (!existsSync(DECK_PDF)) return expect(existsSync(DECK_PDF)).toBe(false);
    const deck = pdfText(DECK_PDF).toUpperCase();
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(deck, `no slide labelled DIMENSION ${String(n)}`).toContain(`DIMENSION ${String(n)}`);
    }
  });
});
