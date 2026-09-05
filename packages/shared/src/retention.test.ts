/**
 * Retention clock — boundary tests (D3-05, AC 2 and AC 3).
 *
 * The acceptance criterion asks for boundaries specifically, and every case below sits *on* one
 * rather than near it. A countdown that is right in the middle of a window and wrong at its edge is
 * wrong exactly when somebody is relying on it.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPIRING_SOON_HOURS,
  MS_PER_DAY,
  MS_PER_HOUR,
  PRESERVATION_DISCLAIMER,
  RETENTION_STATE_MEANING,
  describeRetention,
  expiryOf,
  istCalendarDaysBetween,
  istDate,
  istDateTime,
  istMidnight,
} from './retention.js';

/** 2026-09-01 14:00 IST is 08:30 UTC — a time with a non-zero minute offset, on purpose. */
const FOOTAGE = new Date('2026-09-01T08:30:00.000Z');

function at(offsetMs: number, footage: Date = FOOTAGE, days: number | null = 7) {
  const expiry = footage.getTime() + (days ?? 0) * MS_PER_DAY;
  return describeRetention({
    footageAt: footage,
    retentionDays: days,
    now: new Date(expiry + offsetMs),
  });
}

// ── AC 2 · the expiry boundary itself ───────────────────────────────────────────────────────────

describe('AC 2 — the expiry instant is inclusive: at the mark, it is gone', () => {
  it('one second before expiry the footage still exists', () => {
    const status = at(-1_000);
    expect(status.state).toBe('expiring_soon'); // inside the 48 h fuse, necessarily
    expect(status.remainingMs).toBe(1_000);
  });

  it('at exactly the expiry instant the footage is expired, not available', () => {
    const status = at(0);
    expect(status.state).toBe('expired');
    expect(status.remainingMs).toBe(0);
    expect(status.label).toBe('expired 0m ago');
  });

  it('one second after expiry it is expired', () => {
    const status = at(1_000);
    expect(status.state).toBe('expired');
    expect(status.remainingMs).toBe(-1_000);
  });

  it('a 0-day declared retention expires the footage at the instant it was recorded', () => {
    // Distinct from `null`: "we keep nothing" is an answer; "we did not say" is not.
    const status = describeRetention({ footageAt: FOOTAGE, retentionDays: 0, now: FOOTAGE });
    expect(status.state).toBe('expired');
    expect(status.retentionDays).toBe(0);
    expect(status.expiresAt).toBe(FOOTAGE.toISOString());
  });
});

// ── AC 4 · the threshold boundary, and that it is configurable ──────────────────────────────────

describe('AC 2/AC 4 — the expiring-soon threshold is inclusive and configurable', () => {
  it('at exactly the threshold it is expiring_soon, not available', () => {
    const status = at(-DEFAULT_EXPIRING_SOON_HOURS * MS_PER_HOUR);
    expect(status.remainingMs).toBe(DEFAULT_EXPIRING_SOON_HOURS * MS_PER_HOUR);
    expect(status.state).toBe('expiring_soon');
  });

  it('one millisecond outside the threshold it is still available', () => {
    const status = at(-(DEFAULT_EXPIRING_SOON_HOURS * MS_PER_HOUR + 1));
    expect(status.state).toBe('available');
  });

  it('the same instant reads available at 48 h and expiring_soon at 240 h', () => {
    const now = new Date(FOOTAGE.getTime() + 4 * MS_PER_DAY); // 3 days left of a 7-day window
    const shortFuse = describeRetention({ footageAt: FOOTAGE, retentionDays: 7, now });
    const longFuse = describeRetention({
      footageAt: FOOTAGE,
      retentionDays: 7,
      now,
      expiringSoonHours: 240,
    });

    expect(shortFuse.state).toBe('available');
    expect(longFuse.state).toBe('expiring_soon');
    // The status carries the threshold it was judged against, so a badge can explain itself.
    expect(shortFuse.expiringSoonHours).toBe(48);
    expect(longFuse.expiringSoonHours).toBe(240);
  });
});

// ── AC 3 · unknown is unknown ───────────────────────────────────────────────────────────────────

describe('AC 3 — an undeclared retention period is unknown, never assumed', () => {
  it('carries no expiry and no countdown at all', () => {
    const status = describeRetention({ footageAt: FOOTAGE, retentionDays: null });
    expect(status.state).toBe('unknown');
    expect(status.expiresAt).toBeNull();
    expect(status.remainingMs).toBeNull();
    expect(status.remainingDays).toBeNull();
    expect(status.remainingHours).toBeNull();
    expect(status.expiresOnIstDate).toBeNull();
    expect(status.label).toBe('retention not declared');
  });

  it('is not silently treated as expired, however old the footage is', () => {
    // The failure mode worth naming: a year-old sighting on an undeclared camera must not be
    // reported as gone. An officer told "expired" stops looking; an officer told "unknown" rings
    // the department, and the footage may well still be there.
    const veryOld = describeRetention({
      footageAt: new Date('2020-01-01T00:00:00.000Z'),
      retentionDays: null,
    });
    expect(veryOld.state).toBe('unknown');
    expect(veryOld.state).not.toBe('expired');
  });

  it('expiryOf returns null rather than a default window', () => {
    expect(expiryOf(FOOTAGE, null)).toBeNull();
    expect(expiryOf(FOOTAGE, 15)?.toISOString()).toBe('2026-09-16T08:30:00.000Z');
  });

  it('the legend tells the officer what to DO about an unknown, not just that it is unknown', () => {
    expect(RETENTION_STATE_MEANING.unknown).toContain('Contact the department');
    expect(RETENTION_STATE_MEANING.unknown).toContain('do not assume it is gone');
  });
});

// ── AC 2 · day boundaries, in IST, without DST ──────────────────────────────────────────────────

describe('AC 2 — day-boundary arithmetic in DST-free IST', () => {
  it('an instant just before IST midnight belongs to the earlier IST date', () => {
    // 2026-09-01 23:59 IST = 2026-09-01 18:29 UTC. A naive UTC read gives the same date here…
    expect(istDate('2026-09-01T18:29:00.000Z')).toBe('2026-09-01');
    // …but 2026-09-01 23:59 UTC is already 2026-09-02 05:29 IST, and that is where UTC-based
    // countdowns go wrong by a whole day.
    expect(istDate('2026-09-01T23:59:00.000Z')).toBe('2026-09-02');
  });

  it('midnight IST is 18:30 UTC the previous day', () => {
    expect(istMidnight('2026-09-01T08:30:00.000Z').toISOString()).toBe('2026-08-31T18:30:00.000Z');
  });

  it('counts calendar days, not 24-hour blocks, across an IST midnight', () => {
    // 23:55 IST to 00:05 IST is ten minutes and one calendar day. Both answers are correct; the
    // officer's question ("is that Tuesday's footage?") is the calendar one.
    const before = '2026-09-01T18:25:00.000Z'; // 2026-09-01 23:55 IST
    const after = '2026-09-01T18:35:00.000Z'; // 2026-09-02 00:05 IST
    expect(istCalendarDaysBetween(before, after)).toBe(1);
    expect(after ? new Date(after).getTime() - new Date(before).getTime() : 0).toBe(10 * 60_000);
  });

  it('is unaffected by daylight saving, because IST has none — the March and October cases agree', () => {
    // The dates on which most DST jurisdictions shift. A tz-database lookup would move the offset
    // here; a fixed +05:30 does not, which is the whole reason the AC names IST.
    const march = describeRetention({
      footageAt: '2026-03-29T00:00:00.000Z',
      retentionDays: 7,
      now: '2026-03-29T00:00:00.000Z',
    });
    const october = describeRetention({
      footageAt: '2026-10-25T00:00:00.000Z',
      retentionDays: 7,
      now: '2026-10-25T00:00:00.000Z',
    });
    expect(march.remainingMs).toBe(7 * MS_PER_DAY);
    expect(october.remainingMs).toBe(7 * MS_PER_DAY);
    expect(march.remainingHours).toBe(0);
    expect(october.remainingHours).toBe(0);
  });

  it('a 7-day window on footage recorded late at night expires on the IST date seven days later', () => {
    // 2026-09-01 23:55 IST + 7 days = 2026-09-08 23:55 IST.
    const status = describeRetention({
      footageAt: '2026-09-01T18:25:00.000Z',
      retentionDays: 7,
      now: '2026-09-01T18:25:00.000Z',
    });
    expect(status.expiresOnIstDate).toBe('2026-09-08');
  });

  it('formats an instant for a case file in IST, not UTC', () => {
    expect(istDateTime('2026-09-01T08:30:00.000Z')).toBe('2026-09-01 14:00 IST');
  });
});

// ── The countdown split, and the label ──────────────────────────────────────────────────────────

describe('the countdown splits into days and hours without losing or inventing time', () => {
  it('4 days 6 hours reads as 4d 6h', () => {
    const now = new Date(FOOTAGE.getTime() + 7 * MS_PER_DAY - (4 * MS_PER_DAY + 6 * MS_PER_HOUR));
    const status = describeRetention({ footageAt: FOOTAGE, retentionDays: 7, now });
    expect(status.remainingDays).toBe(4);
    expect(status.remainingHours).toBe(6);
    expect(status.label).toBe('4d 6h left');
  });

  it('an expired countdown reports magnitude with the sign on remainingMs, never "-2d 3h left"', () => {
    const status = at(2 * MS_PER_DAY + 3 * MS_PER_HOUR);
    expect(status.state).toBe('expired');
    expect(status.remainingMs).toBeLessThan(0);
    expect(status.remainingDays).toBe(-2);
    expect(status.remainingHours).toBe(3);
    expect(status.label).toBe('expired 2d 3h ago');
  });

  it('under an hour it degrades to minutes rather than showing 0h 0m', () => {
    expect(at(-90_000).label).toBe('1m left');
  });
});

// ── AC 6 · the claim, exactly ───────────────────────────────────────────────────────────────────

describe('AC 6 — the preservation disclaimer states the limit, not a capability', () => {
  it('says it is an instruction to the owning department and does not extend retention', () => {
    expect(PRESERVATION_DISCLAIMER).toContain('instruction to the owning department');
    expect(PRESERVATION_DISCLAIMER).toContain('does NOT extend retention automatically');
    expect(PRESERVATION_DISCLAIMER).toContain('SAAKSHI does not operate the recorder');
  });
});
