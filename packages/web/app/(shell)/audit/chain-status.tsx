/**
 * The verification banner: the first thing on the screen, and the thing a judge is invited to read.
 *
 * It says what a pass proves **and what it does not** in the same breath, because the claim being
 * made here is narrow and precise — tamper evidence, not tamper prevention — and a banner that said
 * only "VERIFIED" in green would be overstating it to exactly the audience most likely to notice.
 */
import type { ChainVerification } from './types';

const CARD = 'rounded-lg border px-4 py-3 text-sm';
const LABEL = 'text-[11px] font-semibold tracking-wide text-slate-400 uppercase';

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className={LABEL}>{label}</div>
      <div className="mt-0.5 font-mono text-sm text-slate-200 tabular-nums">{value}</div>
    </div>
  );
}

export function ChainStatus({ chain }: { chain: ChainVerification | null }) {
  if (chain === null) {
    return (
      <section className={`${CARD} border-slate-800 bg-slate-900/40 text-slate-400`}>
        The chain could not be verified — the verification endpoint did not answer. That is a fault
        in this screen, not a finding about the chain.
      </section>
    );
  }

  const tone = chain.ok
    ? 'border-emerald-900/60 bg-emerald-950/20'
    : 'border-rose-900/60 bg-rose-950/30';

  return (
    <section className={`${CARD} ${tone}`} data-testid="chain-status">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p
          className={`text-base font-semibold ${chain.ok ? 'text-emerald-200' : 'text-rose-200'}`}
          data-testid="chain-verdict"
        >
          {chain.ok ? 'Chain verifies' : 'Chain does NOT verify'}
        </p>
        <p className="font-mono text-xs text-slate-500">{chain.algorithm}</p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Figure label="Entries" value={chain.entries.toLocaleString('en-GB')} />
        <Figure label="Verified" value={chain.verifiedEntries.toLocaleString('en-GB')} />
        <Figure
          label="Pre-canonical"
          value={chain.preCanonicalEntries.toLocaleString('en-GB')}
        />
        <Figure label="Forks" value={chain.forks.length.toLocaleString('en-GB')} />
      </div>

      {chain.preCanonicalEntries > 0 ? (
        <p className="mt-3 text-xs text-amber-200/80" data-testid="chain-pre-canonical">
          {chain.preCanonicalEntries} entr{chain.preCanonicalEntries === 1 ? 'y was' : 'ies were'}{' '}
          written before the canonical digest existed. Their linkage is verified; their payloads
          cannot be re-hashed, because the serialisation they were written under is not reproducible
          from the stored row. The boundary is {chain.epochSealed ? 'sealed in the chain itself' : 'NOT sealed'}.
        </p>
      ) : null}

      {chain.firstBreak === null ? null : (
        <div
          className="mt-3 rounded-md border border-rose-900/60 bg-rose-950/40 px-3 py-2.5"
          data-testid="chain-break"
        >
          <p className="text-sm font-semibold text-rose-200">
            First broken link — entry {chain.firstBreak.position} of {chain.entries} (
            {chain.firstBreak.reason})
          </p>
          <p className="mt-1 text-xs text-rose-200/80">{chain.firstBreak.detail}</p>
          <dl className="mt-2 grid gap-1 font-mono text-[11px] text-slate-300">
            <div>
              <span className="text-slate-500">entry&nbsp;&nbsp;&nbsp;</span>
              {chain.firstBreak.entry.id}
            </div>
            <div>
              <span className="text-slate-500">action&nbsp;&nbsp;</span>
              {chain.firstBreak.entry.action} · {chain.firstBreak.entry.ts}
            </div>
            <div>
              <span className="text-slate-500">actor&nbsp;&nbsp;&nbsp;</span>
              {chain.firstBreak.entry.actorBadgeNo ?? 'system'} (
              {chain.firstBreak.entry.actorRole ?? 'system'})
            </div>
            <div className="break-all">
              <span className="text-slate-500">expected</span> {chain.firstBreak.expected}
            </div>
            <div className="break-all">
              <span className="text-slate-500">actual&nbsp;&nbsp;</span> {chain.firstBreak.actual}
            </div>
          </dl>
        </div>
      )}

      <p className="mt-3 border-t border-slate-800/80 pt-2.5 text-xs text-slate-400">
        {chain.claim}
      </p>
      <p className="mt-1.5 font-mono text-[11px] break-all text-slate-500">
        tip {chain.tipHash ?? '(the chain is empty)'}
      </p>
    </section>
  );
}
