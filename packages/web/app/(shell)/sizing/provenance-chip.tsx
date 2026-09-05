/**
 * The provenance tag, rendered so it cannot be missed (D3-08).
 *
 * Every number on this screen carries one. Colour is never the only signal — the word is always
 * beside it — because the difference between "we measured this" and "we assumed this" is the whole
 * argument the screen makes, and a reader who cannot tell the hues apart still has to be able to
 * read it.
 */
import type { Provenance } from '@saakshi/shared';
import { PROVENANCE_CLASS, PROVENANCE_TEXT } from '@/src/lib/sizing/present';

export function ProvenanceChip({
  provenance,
  source,
}: {
  provenance: Provenance;
  source?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${PROVENANCE_CLASS[provenance]}`}
      data-provenance={provenance}
      {...(source === undefined ? {} : { title: source })}
    >
      {PROVENANCE_TEXT[provenance]}
    </span>
  );
}
