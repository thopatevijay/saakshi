/**
 * Timestamp formatting that renders identically on the server and in the browser.
 *
 * ## Why this is not just `toLocaleString()`
 *
 * `new Date(iso).toLocaleString()` with no arguments asks the **runtime** for both the locale and
 * the time zone. Node and Chrome answer differently, so a server-rendered timestamp and the same
 * timestamp re-rendered during hydration are different strings — and React treats differing text as
 * a hydration failure:
 *
 *     Error: Hydration failed because the server rendered text didn't match the client.
 *     As a result this tree will be regenerated on the client.
 *
 * That second sentence is the expensive part. React discards the whole server-rendered tree and
 * re-renders it on the client, which on a page like `/trace` — a route map, a sighting timeline and
 * a cloning panel of evidence cards — is a large synchronous re-render immediately after the page
 * appears. The user sees the page paint and then freeze, plus a dev-overlay error. One bad
 * timestamp is enough to do it: D3-14 found `9/5/2026, 3:30:00 PM` from Node against
 * `05/09/2026, 15:30:00` from Chrome, on the same instant.
 *
 * Pinning the locale alone is not enough, because the **time zone** is the other half of the
 * question. A deploy makes this worse rather than better: a container runs UTC while every officer
 * using it is on IST, so the mismatch appears in production even where it did not appear on a
 * developer's laptop.
 *
 * ## Why IST rather than the viewer's zone
 *
 * This is a Gujarat Police product. Every camera, every sighting and every officer reading the
 * screen is in one time zone, and evidence timestamps that silently re-base themselves to whatever
 * laptop is open are worse than useless in a case file — two officers comparing the same sighting
 * must read the same wall-clock time. So the zone is a fixed property of the product, stated once
 * here, not a property of the machine that happens to render it.
 */

/** The estate's time zone. Everything on screen is wall-clock time in Gujarat. */
export const ESTATE_TIME_ZONE = 'Asia/Kolkata';

/** The estate's locale. `en-GB` gives day-first dates and a 24-hour clock. */
export const ESTATE_LOCALE = 'en-GB';

/**
 * Date and time, e.g. `05/09/2026, 15:30`. The default for anything a human reads on screen.
 *
 * Returns an empty string for an unparseable input rather than `Invalid Date`, because these are
 * rendered straight into evidence captions where the literal text `Invalid Date` reads as a data
 * corruption rather than as a missing value.
 */
export function istStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(ESTATE_LOCALE, {
    timeZone: ESTATE_TIME_ZONE,
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

/** Date, time and seconds, e.g. `05/09/2026, 15:30:00` — for evidence, where the second matters. */
export function istStampWithSeconds(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(ESTATE_LOCALE, {
    timeZone: ESTATE_TIME_ZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}
