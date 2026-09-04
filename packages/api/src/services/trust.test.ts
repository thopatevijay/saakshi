/**
 * Trust scoring tests.
 *
 * Calibration is the point of this ticket, so the cases below use the **real values D1-05 measured
 * across all 30 sandbox cameras** rather than invented ones. A scorer that behaves well on made-up
 * numbers and badly on the estate it was built for has proven nothing.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  bandFor,
  focusQuality,
  lightQuality,
  loadWeights,
  score,
  signalsFromRow,
  tamperQuality,
  type HealthSignals,
  type TrustWeights,
} from './trust.js';

const weights = loadWeights();

/** A healthy camera, shaped like the real rows: VOD source, no declared fps in the catalogue. */
function healthy(overrides: Partial<HealthSignals> = {}): HealthSignals {
  return {
    connectable: true,
    decodable: true,
    measuredFps: 25.0,
    declaredFps: null,
    fpsDiverged: false,
    blurScore: 298.6,
    lumaMean: 92.7,
    tamperScore: 0.0,
    ptsDriftMs: 124_007,
    sourceIsVod: true,
    ...overrides,
  };
}

// ── AC 1 · nulls are excluded, never zeroed ─────────────────────────────────────────────────────

describe('AC 1 — nulls are handled explicitly, never as zero', () => {
  it('an unmeasurable frame rate scores HIGHER than a genuinely terrible one', () => {
    /**
     * The single most important assertion in this file.
     *
     * D1-05's handoff, twice bitten: "`measured_fps IS NULL` means could not measure, never zero…
     * Scoring a null as zero condemns a camera for the network's behaviour." If null were treated
     * as zero these two would score the same, and a camera behind a slow link would be marked as
     * badly as one that genuinely runs at 2 fps.
     */
    const unmeasurable = score(healthy({ measuredFps: null }), weights);
    const terrible = score(healthy({ measuredFps: 2.0 }), weights);

    expect(unmeasurable.score).toBeGreaterThan(terrible.score);
    expect(unmeasurable.signals.find((s) => s.signal === 'frameRate')?.quality).toBeNull();
    expect(unmeasurable.excluded.map((e) => e.signal)).toContain('frameRate');
  });

  it('an excluded signal costs nothing at all, rather than costing its full weight', () => {
    // Excluding must renormalise. If it merely skipped the numerator the camera would silently
    // forfeit the weight, which is zeroing wearing a different hat.
    const withFps = score(healthy(), weights);
    const withoutFps = score(healthy({ measuredFps: null }), weights);

    expect(withFps.score).toBe(100);
    expect(withoutFps.score).toBe(100);
  });

  it('the VOD clock signal is excluded on every real sandbox row', () => {
    /**
     * The handoff's other warning. On VOD, pts_drift measures how fast the file was pulled — D1-05
     * measured 24,505 to 161,162 ms across the estate. Scored as clock error that is 30 cameras
     * losing 10 points each for the gateway throttling.
     */
    const result = score(healthy(), weights);
    const clock = result.signals.find((s) => s.signal === 'clock');

    expect(clock?.applicable).toBe(false);
    expect(clock?.points).toBe(0);
    expect(clock?.maxPoints).toBe(0);
    expect(result.excluded.find((e) => e.signal === 'clock')?.reason).toContain('VOD');
    // …and with it excluded, a healthy camera can still reach full marks.
    expect(result.score).toBe(100);
  });

  it('a live camera with a bad clock IS penalised — the exclusion is about VOD, not about clocks', () => {
    const live = score(healthy({ sourceIsVod: false, ptsDriftMs: 5_000 }), weights);
    const clock = live.signals.find((s) => s.signal === 'clock');

    expect(clock?.applicable).toBe(true);
    expect(clock?.quality).toBe(0);
    expect(live.score).toBeLessThan(100);
  });
});

// ── AC 2 · the breakdown explains the score ─────────────────────────────────────────────────────

describe('AC 2 — breakdown names every signal, its value, its weight and its points', () => {
  it('every configured signal appears with raw, weight, points and a readable note', () => {
    const result = score(healthy({ blurScore: 26.34, lumaMean: 38.22 }), weights);

    expect(result.signals.map((s) => s.signal).sort()).toEqual([
      'clock',
      'focus',
      'frameRate',
      'light',
      'reachability',
      'tamper',
    ]);
    for (const s of result.signals) {
      expect(s.weight).toBeGreaterThan(0);
      expect(s.note.length).toBeGreaterThan(10);
      expect(typeof s.points).toBe('number');
    }
  });

  it('the points sum to the score — the gate checkbox, as an assertion', () => {
    for (const signals of [
      healthy(),
      healthy({ blurScore: 0.011, lumaMean: 117.2, tamperScore: 0.388 }),
      healthy({ measuredFps: 4.36 }),
      healthy({ blurScore: null, tamperScore: null }),
      healthy({ connectable: false, decodable: false }),
    ]) {
      const result = score(signals, weights);
      const summed = result.signals.reduce((total, s) => total + s.points, 0);
      expect(Math.abs(summed - result.score)).toBeLessThan(0.01);
    }
  });

  it('names the reason a camera lost its points, not just the number', () => {
    const blind = score(healthy({ blurScore: 0.011 }), weights);
    expect(blind.signals.find((s) => s.signal === 'focus')?.note).toContain('structure floor');
  });
});

// ── AC 3 · weights live in config ───────────────────────────────────────────────────────────────

describe('AC 3 — a weight change alters scores with no code change', () => {
  it('the same signals score differently under a different weights file', () => {
    const base = loadWeights();
    const reweighted: TrustWeights = JSON.parse(JSON.stringify(base)) as TrustWeights;
    // Make focus dominate and reachability nearly irrelevant — the inverse of the shipped config.
    reweighted.signals.focus.weight = 90;
    reweighted.signals.reachability.weight = 1;

    const signals = healthy({ blurScore: 0.011 });
    const before = score(signals, base);
    const after = score(signals, reweighted);

    expect(after.score).not.toBe(before.score);
    expect(after.score).toBeLessThan(before.score);
  });

  it('a weights file on disk is read, not compiled in', () => {
    const custom = path.join(tmpdir(), `trust-weights-${String(Date.now())}.json`);
    const base = JSON.parse(JSON.stringify(loadWeights())) as TrustWeights;
    base.signals.tamper.weight = 999;
    writeFileSync(custom, JSON.stringify(base));

    const loaded = loadWeights(custom);
    expect(loaded.signals.tamper.weight).toBe(999);
    // The shipped config is untouched by having read another one.
    expect(loadWeights().signals.tamper.weight).toBe(15);
  });
});

// ── AC 4 · band boundaries ──────────────────────────────────────────────────────────────────────

describe('AC 4 — bands are correct at the boundaries', () => {
  it.each([
    [100, 'trusted'],
    [70.01, 'trusted'],
    [70, 'trusted'],
    [69.99, 'degraded'],
    [40, 'degraded'],
    [39.99, 'untrusted'],
    [0, 'untrusted'],
  ] as const)('score %s is %s', (value, expected) => {
    expect(bandFor(value, true, weights)).toBe(expected);
  });

  it('unreachable is dead regardless of the number', () => {
    expect(bandFor(100, false, weights)).toBe('dead');
    expect(bandFor(0, false, weights)).toBe('dead');
  });
});

// ── AC 5 · a camera that goes dark ──────────────────────────────────────────────────────────────

describe('AC 5 — a camera that goes dark drops to dead', () => {
  it('scores zero and bands dead when unreachable', () => {
    const dark = score(
      {
        connectable: false,
        decodable: false,
        measuredFps: null,
        blurScore: null,
        lumaMean: null,
        tamperScore: null,
        ptsDriftMs: null,
        sourceIsVod: true,
      },
      weights,
    );

    expect(dark.band).toBe('dead');
    expect(dark.score).toBe(0);
    // Reachability is the only judgeable signal left, so it is the whole denominator.
    expect(dark.signals.find((s) => s.signal === 'reachability')?.maxPoints).toBe(100);
  });

  it('connected but undecodable is untrusted, not dead — they are different faults', () => {
    // The ticket defines `dead` as *unreachable*. A camera that answers but decodes nothing is a
    // stream or codec fault; one that does not answer is a network or power fault. They send
    // different people to different places, so the score must not blur them into one band.
    const mute = score(
      {
        connectable: true,
        decodable: false,
        measuredFps: null,
        blurScore: null,
        lumaMean: null,
        tamperScore: null,
        ptsDriftMs: null,
        sourceIsVod: true,
      },
      weights,
    );

    expect(mute.band).toBe('untrusted');
    expect(mute.score).toBe(0);
  });
});

// ── Calibration against the real estate ─────────────────────────────────────────────────────────

describe('calibration against the 30 cameras D1-05 actually measured', () => {
  it('the estate median camera is trusted', () => {
    // blur 298.6, luma 92.7, tamper 0.000, fps 25.00 — the measured medians.
    expect(score(healthy(), weights).band).toBe('trusted');
  });

  it('cam22 — blur 0.011, tamper 0.388 — is not trusted', () => {
    const cam22 = score(
      healthy({ blurScore: 0.011, lumaMean: 117.2, tamperScore: 0.388, measuredFps: 25.0 }),
      weights,
    );
    expect(cam22.band).not.toBe('trusted');
    expect(cam22.signals.find((s) => s.signal === 'focus')?.quality).toBe(0);
    expect(cam22.signals.find((s) => s.signal === 'tamper')?.quality).toBe(0);
  });

  it('cam09 — luma 8.40, blur 2.047 — is not trusted', () => {
    const cam09 = score(
      healthy({ blurScore: 2.047, lumaMean: 8.4, tamperScore: 0.335, measuredFps: 25.0 }),
      weights,
    );
    expect(cam09.band).not.toBe('trusted');
    expect(cam09.signals.find((s) => s.signal === 'light')?.quality).toBe(0);
  });

  it('cam25 — the sharpest camera measured, blur 5794 — is trusted', () => {
    expect(score(healthy({ blurScore: 5794.088, lumaMean: 73.08 }), weights).band).toBe('trusted');
  });

  it('the log focus curve puts the estate median at full marks, where linear would not', () => {
    const { floor, target } = weights.signals.focus;
    // Linear against the observed maximum would give the median 298.6/5794.088 = 5%.
    const linear = 298.6 / 5794.088;
    const log = focusQuality(298.6, floor, target);

    expect(log).toBe(1);
    expect(linear).toBeLessThan(0.06);
  });

  it('the tamper curve separates the two degraded cameras from the 24 clean ones', () => {
    const { cleanMax, severeMin } = weights.signals.tamper;
    expect(tamperQuality(0.0, cleanMax, severeMin)).toBe(1);
    expect(tamperQuality(0.388, cleanMax, severeMin)).toBe(0);
    expect(tamperQuality(0.335, cleanMax, severeMin)).toBe(0);
    // cam29 at 0.046 is under the clean mark — real estates are noisy and that is not tamper.
    expect(tamperQuality(0.046, cleanMax, severeMin)).toBe(1);
    // cam27 at 0.179 sits between: elevated, not condemned.
    const middling = tamperQuality(0.179, cleanMax, severeMin);
    expect(middling).toBeGreaterThan(0);
    expect(middling).toBeLessThan(1);
  });

  it('the two cameras below the luma floor score zero light, the rest do not', () => {
    const { darkMax, usableMin, blownMin } = weights.signals.light;
    expect(lightQuality(8.4, darkMax, usableMin, blownMin)).toBe(0);
    expect(lightQuality(38.22, darkMax, usableMin, blownMin)).toBe(0);
    expect(lightQuality(65.74, darkMax, usableMin, blownMin)).toBe(1);
    expect(lightQuality(135.19, darkMax, usableMin, blownMin)).toBe(1);
  });
});

// ── Reading D1-05's row shape ───────────────────────────────────────────────────────────────────

describe('signalsFromRow reads D1-05 breakdown jsonb', () => {
  it('extracts declared fps, divergence and the VOD flag', () => {
    const signals = signalsFromRow({
      connectable: true,
      decodable: true,
      measuredFps: 15.4,
      blurScore: 166.8,
      lumaMean: 97.56,
      tamperScore: 0,
      ptsDriftMs: 76_443,
      breakdown: {
        source_is_vod: true,
        fps: { declared: 30, diverged: true },
      },
    });

    expect(signals.declaredFps).toBe(30);
    expect(signals.fpsDiverged).toBe(true);
    expect(signals.sourceIsVod).toBe(true);
  });

  it('survives a breakdown with nothing in it', () => {
    const signals = signalsFromRow({
      connectable: false,
      decodable: false,
      measuredFps: null,
      blurScore: null,
      lumaMean: null,
      tamperScore: null,
      ptsDriftMs: null,
      breakdown: {},
    });
    expect(signals.declaredFps).toBeNull();
    expect(signals.fpsDiverged).toBe(false);
  });
});
