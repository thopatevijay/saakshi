/**
 * Retention presentation (D3-05).
 *
 * The assertions that matter here are the negative ones: that `unknown` is drawn as its own thing
 * rather than as a faded `expired`, and that no threshold arithmetic has crept into the UI layer.
 */
import { describe, expect, it } from 'vitest';
import { describeRetention } from '@saakshi/shared';
import {
  RETENTION_SORT,
  RETENTION_STATES,
  RETENTION_STYLE,
  evidenceClockSentence,
  retentionStyleOf,
  retentionWindowLabel,
} from './retention';

describe('the chip is a lookup on the API’s state, never a recomputation', () => {
  it('has a style for every state and no others', () => {
    expect(Object.keys(RETENTION_STYLE).sort()).toEqual([...RETENTION_STATES].sort());
  });

  it('draws "not declared" with a different shape, not a paler colour', () => {
    // D1-08's rule, transferred: an absence of evidence must not be renderable as a bad result.
    expect(RETENTION_STYLE.unknown.chip).toContain('border-dashed');
    for (const state of ['available', 'expiring_soon', 'expired'] as const) {
      expect(RETENTION_STYLE[state].chip).not.toContain('border-dashed');
    }
  });

  it('every meaning says what the colour asserts, and the unknown one says what to do', () => {
    for (const state of RETENTION_STATES) {
      expect(retentionStyleOf(state).meaning.length).toBeGreaterThan(40);
    }
    expect(RETENTION_STYLE.unknown.meaning).toContain('Contact the department');
    expect(RETENTION_STYLE.unknown.meaning).toContain('never assume it is gone');
    // The honest caveat on the harshest verdict: a declared period is a policy, not a disk read.
    expect(RETENTION_STYLE.expired.meaning).toContain('not an observation of the disk');
  });

  it('contains no threshold arithmetic — the API owns the boundary', () => {
    const source = JSON.stringify(RETENTION_STYLE) + JSON.stringify(RETENTION_SORT);
    expect(source).not.toMatch(/\b48\b/);
    expect(source).not.toMatch(/expiresAt/);
  });

  it('orders the most urgent first and the unknowable last', () => {
    const order = [...RETENTION_STATES].sort((a, b) => RETENTION_SORT[a] - RETENTION_SORT[b]);
    expect(order).toEqual(['expired', 'expiring_soon', 'available', 'unknown']);
  });
});

describe('the retention window label', () => {
  it('distinguishes "declared as zero" from "never declared"', () => {
    // A department that keeps nothing has answered. One that never answered has not.
    expect(retentionWindowLabel(0)).toBe('kept for 0 days');
    expect(retentionWindowLabel(null)).toBe('not declared');
    expect(retentionWindowLabel(1)).toBe('1 day');
    expect(retentionWindowLabel(15)).toBe('15 days');
  });
});

describe('the sentence an alert detail shows', () => {
  it('says "expires in N" for footage that still exists', () => {
    const status = describeRetention({
      footageAt: '2026-09-01T08:30:00.000Z',
      retentionDays: 7,
      now: '2026-09-04T08:30:00.000Z',
    });
    expect(evidenceClockSentence(status)).toBe('This evidence expires in 4d 0h — 2026-09-08 IST.');
  });

  it('says when the window closed for footage that has gone', () => {
    const status = describeRetention({
      footageAt: '2026-09-01T08:30:00.000Z',
      retentionDays: 7,
      now: '2026-09-10T08:30:00.000Z',
    });
    expect(evidenceClockSentence(status)).toContain('expired 2d 0h ago');
    expect(evidenceClockSentence(status)).toContain('window closed 2026-09-08 IST');
  });

  it('refuses to guess when nothing was declared', () => {
    const status = describeRetention({
      footageAt: '2026-09-01T08:30:00.000Z',
      retentionDays: null,
      now: '2027-01-01T00:00:00.000Z',
    });
    const sentence = evidenceClockSentence(status);
    expect(sentence).toContain('declared no retention period');
    expect(sentence).not.toContain('expired');
  });
});
