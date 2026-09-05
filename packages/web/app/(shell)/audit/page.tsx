/**
 * The chain viewer — read-only, and read-only by construction rather than by restraint.
 *
 * There is no action on this screen because there is no action to offer: `audit_log` is append-only
 * in the database itself (grants plus BEFORE UPDATE/DELETE triggers), the API exposes no write route
 * for it, and an auditor's role carries no capability that would let them use one if it existed.
 *
 * A server component, with the filters in the URL, so an auditor's view is a link they can put in a
 * case note and a colleague opens the same rows.
 */
import { UserRole, can } from '@saakshi/shared';
import { getSession } from '@/src/lib/session';
import { EmptyState } from '@/src/components/states';
import { loadAudit } from './actions';
import { ChainStatus } from './chain-status';
import { EntryRow } from './entry-row';

export const dynamic = 'force-dynamic';

const FIELD =
  'h-9 rounded-md border border-slate-700 bg-slate-900 px-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400';
const LABEL = 'text-[11px] font-semibold tracking-wide text-slate-400 uppercase';

function one(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return (Array.isArray(value) ? (value[0] ?? '') : value).trim();
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await getSession();
  if (session === null) return null;

  const role = UserRole.parse(session.user.role);
  const filters = {
    action: one(params['action']),
    badgeNo: one(params['badge_no']),
    caseRef: one(params['case_ref']),
    from: one(params['from']),
    to: one(params['to']),
    limit: 100,
  };

  const view = await loadAudit(filters);
  const entries = view.page?.entries ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">Audit chain</h1>
        <p className="text-xs text-slate-500 tabular-nums">
          {view.elapsedMs} ms
          {view.page === null ? null : ` · ${view.page.total.toLocaleString('en-GB')} matching entries`}
        </p>
      </div>

      <ChainStatus chain={view.chain} />

      {/* Filters live in the URL so a view is a link. GET, not a server action: an auditor sharing
          "every export against FIR/2026/00123" should be sharing an address. */}
      <form method="GET" role="search" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Action</span>
          <input
            name="action"
            defaultValue={filters.action}
            placeholder="trace.run"
            className={`${FIELD} w-48 font-mono`}
            data-testid="audit-filter-action"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Badge</span>
          <input
            name="badge_no"
            defaultValue={filters.badgeNo}
            placeholder="GP-SUP-0100"
            className={`${FIELD} w-40 font-mono`}
            data-testid="audit-filter-badge"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Case / FIR</span>
          <input
            name="case_ref"
            defaultValue={filters.caseRef}
            placeholder="FIR/2026/00123"
            className={`${FIELD} w-44 font-mono`}
            data-testid="audit-filter-case"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>From</span>
          <input type="datetime-local" name="from" defaultValue={filters.from} className={`${FIELD} w-56`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>To</span>
          <input type="datetime-local" name="to" defaultValue={filters.to} className={`${FIELD} w-56`} />
        </label>
        <button
          type="submit"
          className="h-9 rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-medium text-slate-100 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          data-action="audit-search"
        >
          Search
        </button>
      </form>

      {view.error !== null ? (
        <p
          role="alert"
          className="rounded-md border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-200"
        >
          {view.error}
        </p>
      ) : null}

      {view.error === null && entries.length === 0 ? (
        <EmptyState
          title="No entries match"
          description="Nothing in the chain matches these filters. That is an answer — the chain is append-only, so an action that happened is still recorded whether or not this search finds it."
        />
      ) : null}

      {entries.length === 0 ? null : (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full min-w-5xl border-collapse text-left">
            <thead>
              <tr className="bg-slate-900/60">
                <th className={`px-3 py-2 ${LABEL}`}>#</th>
                <th className={`px-3 py-2 ${LABEL}`}>When</th>
                <th className={`px-3 py-2 ${LABEL}`}>Actor</th>
                <th className={`px-3 py-2 ${LABEL}`}>Action</th>
                <th className={`px-3 py-2 ${LABEL}`}>Target</th>
                <th className={`px-3 py-2 ${LABEL}`}>Stated purpose</th>
                <th className={`px-3 py-2 ${LABEL}`}>Case</th>
                <th className={`px-3 py-2 text-right ${LABEL}`}>Results</th>
                <th className={`px-3 py-2 ${LABEL}`}>Entry</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view.page === null ? null : (
        <p className="text-xs text-slate-500" data-testid="audit-disclaimer">
          {view.page.disclaimer}
        </p>
      )}

      {can(role, 'audit:export') ? null : (
        <p className="text-xs text-slate-600">
          Your role can read the chain but not export from it.
        </p>
      )}
    </div>
  );
}
