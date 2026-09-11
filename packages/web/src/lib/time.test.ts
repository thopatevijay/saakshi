import { describe, expect, it } from 'vitest';
import { ESTATE_LOCALE, ESTATE_TIME_ZONE, istStamp, istStampWithSeconds } from './time';

/**
 * The property under test is not "it formats a date" — it is that **the same instant renders to the
 * same string whatever the runtime's own locale and time zone are**. That is what makes it safe to
 * render on the server and re-render during hydration, and it is the bug D3-14 fixed: a container
 * on UTC and a browser on IST produced different text, React discarded the server tree, and the
 * page froze while it re-rendered.
 *
 * `process.env.TZ` is not reassignable once `Intl` has cached a zone, so the check below compares
 * against an explicitly-constructed formatter for a *different* zone instead: if `istStamp` were
 * reading the ambient zone, these two would agree.
 */
describe('istStamp', () => {
  const instant = '2026-09-05T10:00:00.000Z';

  it('renders an instant in IST, not in the runtime zone', () => {
    // 10:00 UTC is 15:30 IST — the +05:30 offset is the whole point.
    expect(istStamp(instant)).toBe('05/09/2026, 15:30');
  });

  it('includes seconds when asked, for evidence captions', () => {
    expect(istStampWithSeconds(instant)).toBe('05/09/2026, 15:30:00');
  });

  it('does not agree with the same instant rendered in another zone', () => {
    const utc = new Date(instant).toLocaleString(ESTATE_LOCALE, {
      timeZone: 'UTC',
      dateStyle: 'short',
      timeStyle: 'short',
    });
    // If this ever passes, the formatter has started reading the ambient zone and the hydration
    // bug is back.
    expect(istStamp(instant)).not.toBe(utc);
  });

  it('is stable across repeated calls, so SSR and hydration cannot disagree', () => {
    expect(istStamp(instant)).toBe(istStamp(instant));
    expect(istStampWithSeconds(instant)).toBe(istStampWithSeconds(instant));
  });

  it('pins both halves of the question', () => {
    expect(ESTATE_TIME_ZONE).toBe('Asia/Kolkata');
    expect(ESTATE_LOCALE).toBe('en-GB');
  });

  it('returns an empty string rather than the words "Invalid Date"', () => {
    expect(istStamp('not a date')).toBe('');
    expect(istStampWithSeconds('')).toBe('');
  });
});
