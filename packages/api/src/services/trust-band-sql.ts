/**
 * The trust band, resolved in SQL — **the single source, shared by every reader**.
 *
 * This module exists because D1-08's handoff is a standing rule ("take the band from the API, never
 * `trust_score >= 70`") and D3-06 became the second reader. Two readers of a rule expressed as a
 * private const in one route file is how the rule quietly stops being true: the second copy drifts,
 * and nothing fails. So the expression moved here and `routes/cameras.ts` imports it.
 *
 * D1-06's reasoning, preserved verbatim from where this used to live:
 *
 * > an unreachable camera keeps its last good score, because a camera that answered nothing has no
 * > signals to compute a new number from. So the stored number says `trusted` about a camera that
 * > went dark yesterday, and a map coloured from it is exactly the false assurance Pillar 1 exists
 * > to remove.
 *
 * `dead` therefore comes from the **latest health check's** `connectable`, and the thresholds are
 * read from `config/trust-weights.json` rather than written here, so a weight change moves the
 * map's colours without a code change.
 */
import { sql } from 'drizzle-orm';
import { cameraHealthChecks, cameras } from '@saakshi/shared/db';
import { loadWeights } from './trust.js';

const BANDS = loadWeights().bands;

export type ResolvedBand = 'trusted' | 'degraded' | 'untrusted' | 'dead' | null;

/**
 * `null` means **never probed** — an absence of evidence, not a bad result. Every consumer must
 * render or count it differently from a low score (D1-08).
 */
export const bandSql = sql<ResolvedBand>`
  case
    when ${cameras.trustScore} is null then null
    when (select h.connectable
            from ${cameraHealthChecks} h
           where h.camera_id = ${cameras.id}
           order by h.checked_at desc
           limit 1) is false then 'dead'
    when ${cameras.trustScore} >= ${BANDS.trusted} then 'trusted'
    when ${cameras.trustScore} >= ${BANDS.degraded} then 'degraded'
    else 'untrusted'
  end`;

/**
 * D1-06's necessary condition, which the additive score cannot express.
 *
 * > "a camera that cannot produce a readable image produces nothing for ANPR, whatever else is true
 * > of it. So `cam22` — blur 0.011 — scores 55 and lands in `degraded` on the strength of being
 * > reachable, well-lit and running at 25 fps. A gap analysis that trusts the band will count
 * > `cam22` as partial coverage. It is **zero** coverage."
 *
 * True when the latest health check recorded `focus` quality 0. Kept separate from `bandSql` on
 * purpose: this is a veto applied on top of a band, not a band of its own, and collapsing the two
 * would change what `degraded` means for every other reader.
 */
export const focusDisqualifiedSql = sql<boolean>`
  coalesce((
    select exists (
      select 1
        from jsonb_array_elements(coalesce(h.breakdown -> 'trust' -> 'signals', '[]'::jsonb)) s
       where s ->> 'signal' = 'focus'
         and (s ->> 'quality') is not null
         and (s ->> 'quality')::numeric = 0
    )
      from ${cameraHealthChecks} h
     where h.camera_id = ${cameras.id}
     order by h.checked_at desc
     limit 1
  ), false)`;
