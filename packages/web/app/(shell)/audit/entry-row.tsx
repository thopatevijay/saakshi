/**
 * One row of the chain.
 *
 * Two things are non-obvious and both are deliberate:
 *
 * **The status badge is recomputed, not stored.** The API re-hashes every entry it returns, so a row
 * that says `ok` is saying "this entry still hashes to its stored value", not "a column said so". A
 * viewer that displayed rows without re-checking them would be a list, not an audit.
 *
 * **`resultCount` renders through `explainedNull`.** A search that returned nothing and a search
 * whose result count was never recorded are different facts, and rendering the second as `0` would
 * put a number in front of an auditor that nobody measured. `packages/web/src/lib/alerts/present.ts`
 * owns that distinction and every screen imports it rather than re-deriving it.
 */
import { explainedNull, formatClock, formatDate } from '@/src/lib/alerts/present';
import type { AuditEntry, AuditEntryStatus } from './types';

const STATUS_STYLE: Record<AuditEntryStatus, { label: string; className: string; title: string }> =
  {
    ok: {
      label: 'verified',
      className: 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300',
      title: 'This entry still hashes to its stored value.',
    },
    pre_canonical: {
      label: 'pre-canonical',
      className: 'border-amber-900/60 bg-amber-950/30 text-amber-300',
      title:
        'Written before the canonical digest existed. Its place in the chain is verified; its payload cannot be re-hashed.',
    },
    hash_mismatch: {
      label: 'ALTERED',
      className: 'border-rose-900/60 bg-rose-950/40 text-rose-300',
      title:
        'This entry does not hash to its stored value — its contents changed after it was written.',
    },
  };

export function EntryRow({ entry }: { entry: AuditEntry }) {
  const status = STATUS_STYLE[entry.status];

  return (
    <tr
      className="border-t border-slate-800 align-top"
      data-testid="audit-row"
      data-status={entry.status}
    >
      <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap text-slate-400 tabular-nums">
        {entry.seq}
      </td>
      <td className="px-3 py-2.5 text-xs whitespace-nowrap text-slate-300">
        <div>{formatClock(entry.ts)}</div>
        <div className="text-slate-500">{formatDate(entry.ts)}</div>
      </td>
      <td className="px-3 py-2.5 text-xs whitespace-nowrap text-slate-200">
        <div className="font-mono">{entry.actorBadgeNo ?? 'system'}</div>
        <div className="text-slate-500">{entry.actorRole ?? 'no operator in the loop'}</div>
      </td>
      <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap text-sky-300">
        {entry.action}
      </td>
      <td className="px-3 py-2.5 text-xs text-slate-300">
        <div className="font-mono break-all">{entry.targetId ?? '—'}</div>
        <div className="text-slate-500">{entry.targetType}</div>
      </td>
      <td className="max-w-md px-3 py-2.5 text-xs text-slate-200">{entry.purpose}</td>
      <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap text-slate-300">
        {entry.caseRef ?? '—'}
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap text-slate-300 tabular-nums">
        {explainedNull(entry.resultCount, 'not recorded')}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <span
          title={status.title}
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${status.className}`}
        >
          {status.label}
        </span>
      </td>
    </tr>
  );
}
