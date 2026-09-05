import { describe, expect, it } from 'vitest';
import { deliveryRate, deliveryReason, deliveryVerdict, rollingDeliveryRate } from './delivery';

describe('deliveryRate', () => {
  it('reports the sandbox’s measured behaviour as the fraction of real time it is', () => {
    // 2026-09-05, measured: a 6.006 s segment arrived in 21,781 ms and another in 48,742 ms.
    expect(deliveryRate({ durationS: 6.006, loadMs: 21_781 })?.toFixed(2)).toBe('0.28');
    expect(deliveryRate({ durationS: 6.006, loadMs: 48_742 })?.toFixed(2)).toBe('0.12');
  });

  it('reports a cached segment as very fast, because it is', () => {
    expect(deliveryRate({ durationS: 6, loadMs: 3 })).toBeGreaterThan(100);
  });

  it('has no opinion when there is nothing to measure', () => {
    expect(deliveryRate({ durationS: 0, loadMs: 100 })).toBeNull();
    expect(deliveryRate({ durationS: 6, loadMs: 0 })).toBeNull();
  });
});

describe('rollingDeliveryRate', () => {
  it('totals seconds over totals of wall time, so one cache hit cannot skew it', () => {
    const rate = rollingDeliveryRate([
      { durationS: 6, loadMs: 3 }, // cache hit: 2000x on its own
      { durationS: 6, loadMs: 30_000 },
      { durationS: 6, loadMs: 30_000 },
    ]);
    // 18 s over 60.003 s ≈ 0.30x — the truth. A mean of ratios would have said ~667x.
    expect(rate?.toFixed(2)).toBe('0.30');
  });

  it('ignores unusable samples and returns null when none remain', () => {
    expect(rollingDeliveryRate([{ durationS: 0, loadMs: 0 }])).toBeNull();
    expect(rollingDeliveryRate([])).toBeNull();
  });
});

describe('deliveryVerdict', () => {
  it('calls the measured sandbox rates throttled', () => {
    expect(deliveryVerdict(0.12)).toBe('throttled');
    expect(deliveryVerdict(0.28)).toBe('throttled');
  });

  it('calls barely-enough marginal rather than fine', () => {
    expect(deliveryVerdict(1.0)).toBe('marginal');
    expect(deliveryVerdict(1.49)).toBe('marginal');
  });

  it('calls comfortably-ahead realtime', () => {
    expect(deliveryVerdict(1.5)).toBe('realtime');
    expect(deliveryVerdict(2000)).toBe('realtime');
  });

  it('says unknown before the first segment', () => {
    expect(deliveryVerdict(null)).toBe('unknown');
    expect(deliveryVerdict(Number.NaN)).toBe('unknown');
  });
});

describe('deliveryReason', () => {
  it('names the gateway, not the console, when the rate is below real time', () => {
    const reason = deliveryReason(0.12, 'throttled');
    expect(reason).toContain('0.12×');
    expect(reason).toContain('gateway is throttling, not this console');
  });

  it('says something useful in every state', () => {
    for (const verdict of ['realtime', 'marginal', 'throttled', 'unknown'] as const) {
      expect(deliveryReason(1, verdict).length).toBeGreaterThan(20);
    }
  });
});
