import { describe, expect, it } from 'vitest';
import { EDITABLE_CONSTANT_KEYS, SIZING_PRESETS, presetById } from '@saakshi/shared';
import {
  INPUT_BOUNDS,
  PROVENANCE_CLASS,
  PROVENANCE_TEXT,
  clampInput,
  formatCount,
  formatGbps,
  formatRatio,
  formatTB,
  formatTBBand,
  matchesPreset,
  provenanceCounts,
  scenarioForExport,
} from './present';

describe('clampInput', () => {
  it('keeps a value inside its bounds', () => {
    expect(clampInput('anprCoveragePct', 150)).toBe(100);
    expect(clampInput('anprCoveragePct', -20)).toBe(0);
    expect(clampInput('anprCoveragePct', 30)).toBe(30);
  });

  it('never returns NaN, because a NaN reaching the model renders every output as a crash', () => {
    // A cleared field and a half-typed number both arrive here as unparseable strings.
    expect(clampInput('cameras', '')).toBe(INPUT_BOUNDS.cameras.min);
    expect(clampInput('cameras', '-')).toBe(INPUT_BOUNDS.cameras.min);
    expect(clampInput('cameras', 'abc')).toBe(INPUT_BOUNDS.cameras.min);
    expect(Number.isNaN(clampInput('cameras', Number.NaN))).toBe(false);
  });

  it('parses a numeric string from an input event', () => {
    expect(clampInput('cameras', '80000')).toBe(80_000);
  });

  it('reaches the 1,00,000 benchmark the evaluation criteria state', () => {
    expect(clampInput('cameras', 100_000)).toBe(100_000);
    expect(INPUT_BOUNDS.cameras.max).toBeGreaterThanOrEqual(100_000);
  });
});

describe('matchesPreset', () => {
  it('is true for an untouched preset', () => {
    for (const p of SIZING_PRESETS) expect(matchesPreset(p.inputs, p.id), p.id).toBe(true);
  });

  it('is false once any field moves', () => {
    const statewide = presetById('statewide')!;
    expect(matchesPreset({ ...statewide.inputs, cameras: 80_001 }, 'statewide')).toBe(false);
    expect(matchesPreset({ ...statewide.inputs, cropRetentionDays: 91 }, 'statewide')).toBe(false);
  });

  it('is false for an unknown preset id', () => {
    expect(matchesPreset(SIZING_PRESETS[0]!.inputs, 'nope')).toBe(false);
  });
});

describe('scenarioForExport', () => {
  it('returns the real preset while the inputs are untouched', () => {
    const statewide = presetById('statewide')!;
    expect(scenarioForExport(statewide.inputs, 'statewide')).toBe(statewide);
  });

  it('relabels a modified scenario, so an export never claims to be a preset it is not', () => {
    // A document headed "Statewide" that no longer holds the statewide numbers would be the worst
    // possible output of a tool whose entire purpose is traceability.
    const statewide = presetById('statewide')!;
    const scenario = scenarioForExport({ ...statewide.inputs, cameras: 12_345 }, 'statewide');
    expect(scenario.id).toBe('custom');
    expect(scenario.label).toBe('Custom (12,345 cameras)');
    expect(scenario.rationale).toContain('Statewide');
    expect(scenario.inputs.cameras).toBe(12_345);
  });
});

describe('provenance is visible and never conveyed by colour alone', () => {
  it('gives every tag a word as well as a class', () => {
    for (const p of ['measured', 'listed', 'assumed'] as const) {
      expect(PROVENANCE_TEXT[p].length).toBeGreaterThan(0);
      expect(PROVENANCE_CLASS[p]).toMatch(/text-/);
    }
    expect(PROVENANCE_TEXT.listed).toBe('vendor-listed');
  });

  it('counts the editable constants by provenance', () => {
    const counts = provenanceCounts(EDITABLE_CONSTANT_KEYS);
    expect(counts.measured + counts.listed + counts.assumed).toBe(EDITABLE_CONSTANT_KEYS.length);
    expect(EDITABLE_CONSTANT_KEYS.length).toBeGreaterThan(10);
  });
});

describe('formatting', () => {
  it('scales bandwidth to a readable unit', () => {
    expect(formatGbps(160)).toBe('160.00 Gbps');
    expect(formatGbps(0.056)).toBe('56.0 Mbps');
    expect(formatGbps(0.0000462963)).toBe('46.3 kbps');
    expect(formatGbps(Number.NaN)).toBe('—');
  });

  it('scales storage to a readable unit', () => {
    expect(formatTB(0.5)).toBe('500.0 GB');
    expect(formatTB(202.4)).toBe('202.4 TB');
    expect(formatTB(2591)).toBe('2.59 PB');
  });

  it('collapses a band with no width', () => {
    expect(formatTBBand({ low: 5, high: 5 })).toBe('5.0 TB');
    expect(formatTBBand({ low: 5, high: 10 })).toBe('5.0 TB – 10.0 TB');
  });

  it('renders ratios and counts', () => {
    expect(formatRatio(125.04)).toBe('125x');
    expect(formatRatio(43.6)).toBe('43.6x');
    expect(formatRatio(Infinity)).toBe('∞');
    expect(formatCount(80_000)).toBe('80,000');
  });
});
