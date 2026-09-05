/**
 * Plate normalisation — the canonical stored form.
 *
 * **This is a contract, not an implementation detail.** `watchlist_entries.plate_normalized` and
 * every watchlist lookup are keyed on the output of this function (D2-05, #19), and D2-04's fuzzy
 * index keys on `plate_reads.normalized_text`, which is also this. Changing the output character
 * set silently breaks matching: the row is still there, the equality just never holds. The set is
 * `[A-Z0-9]` and it stays `[A-Z0-9]`.
 *
 * Zero I/O, no dependencies, no throw paths.
 */

/**
 * Noise prefixes stamped on the plate itself rather than part of the registration.
 *
 * Indian plates carry the `IND` country mark beside the national emblem on the left of the plate,
 * and a plate-detector crop routinely includes it. No Indian RTO state code begins with `IN`, so
 * removing a leading `IND` cannot eat a real registration.
 *
 * Stripped in a loop so that `normalise` stays idempotent: a crop that yields `INDINDGJ01AB1234`
 * must reduce in one call, otherwise `normalise(normalise(x)) !== normalise(x)`.
 */
const NOISE_PREFIXES = ['IND'] as const;

/**
 * Reduce a raw OCR read (or a human-typed registration) to the canonical comparable form.
 *
 * Uppercases, drops every character outside `A-Z0-9` (spaces, hyphens, dots, the state emblem's
 * garbage glyphs, Devanagari, control characters, emoji), then strips leading plate furniture.
 *
 * **Total** — every input produces a string; nothing throws, including `null`, `undefined`, numbers
 * and objects arriving from untyped JSON at a queue boundary.
 * **Idempotent** — `normalise(normalise(x)) === normalise(x)` for all `x`.
 *
 * It performs **no grammar validation**: `normalise('CIRCLE')` is `'CIRCLE'`. Deciding whether the
 * result could be a registration is {@link validate}'s job, and keeping the two separate is what
 * lets an ungrammatical read still be stored and flagged rather than silently discarded.
 *
 * @example
 * normalise(' ind gj-01 ab 1234 ') // 'GJ01AB1234'
 */
export function normalise(raw: unknown): string {
  if (typeof raw !== 'string') {
    // Untyped JSON at a queue or CSV boundary. A number is the one non-string worth coercing —
    // an all-digit read parsed as a number by a JSON reader is a real case (`44671`).
    if (typeof raw === 'number' && Number.isFinite(raw)) return normalise(String(raw));
    return '';
  }

  let text = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const prefix of NOISE_PREFIXES) {
      if (text.startsWith(prefix) && text.length > prefix.length) {
        text = text.slice(prefix.length);
        stripped = true;
      }
    }
  }

  return text;
}
