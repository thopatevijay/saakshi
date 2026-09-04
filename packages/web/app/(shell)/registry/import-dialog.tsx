'use client';

/**
 * Onboarding path 1 — bulk import.
 *
 * ## The row-level report is the point
 *
 * "Bulk import succeeds with the 50-row fixture **and shows the row-level error report** for the
 * invalid one." A dialog that says *3 rows failed* sends the operator back to a 50-row spreadsheet
 * with no idea where to look, and they re-upload the same broken file. So every rejection is
 * rendered with its row number — 1-based over data rows, the number the spreadsheet shows — its
 * external id where one was parseable, and each field error.
 *
 * The valid rows still commit. The API runs them as **one transaction**, so what never happens is a
 * partial commit of a batch: the good rows land whole or not at all, and the bad ones come back as
 * this table. Saying so on screen matters, because an operator who thinks a failed import might
 * have half-landed will not re-run it.
 */
import { useActionState, useRef } from 'react';
import { importCameras } from './actions';
import type { ImportState } from './types';

const INITIAL: ImportState = { report: null, error: null };

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(importCameras, INITIAL);
  const fileInput = useRef<HTMLInputElement | null>(null);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-heading"
      data-testid="import-dialog"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/70 px-4 py-10 backdrop-blur-sm"
    >
      <div className="w-full max-w-2xl rounded-lg border border-slate-800 bg-slate-950 shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-4">
          <div>
            <h2 id="import-heading" className="text-sm font-semibold text-slate-100">
              Bulk import
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              CSV or JSON. Rows upsert on department + camera id, so re-importing the same file
              updates rather than duplicates.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            Close
          </button>
        </header>

        <form action={formAction} className="space-y-4 px-6 py-5">
          <label className="block space-y-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              File
            </span>
            <input
              ref={fileInput}
              type="file"
              name="file"
              accept=".csv,.json,text/csv,application/json"
              required
              data-testid="import-file"
              className="block w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-slate-800 file:px-3 file:py-1.5 file:text-xs file:text-slate-200"
            />
          </label>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-sky-700 px-4 py-2 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            >
              {pending ? 'Importing…' : 'Import'}
            </button>
            <span className="text-[11px] text-slate-500">
              Columns match the export, so an export re-imports cleanly.
            </span>
          </div>

          {state.error === null ? null : (
            <p
              role="alert"
              className="rounded-md border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-200"
            >
              {state.error}
            </p>
          )}

          {state.report === null ? null : (
            <section className="space-y-3" data-testid="import-report">
              <dl className="grid grid-cols-5 gap-2 rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2.5 text-center">
                {(
                  [
                    ['received', state.report.received],
                    ['imported', state.report.imported],
                    ['created', state.report.created],
                    ['updated', state.report.updated],
                    ['rejected', state.report.rejected.length],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt>
                    <dd
                      data-report={label}
                      className={`text-sm font-semibold tabular-nums ${
                        label === 'rejected' && value > 0 ? 'text-rose-300' : 'text-slate-100'
                      }`}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              <p className="text-[11px] leading-relaxed text-slate-500">
                The valid rows committed as one transaction — a batch never lands half-written. The
                rows below were rejected before that transaction ran and changed nothing.
              </p>

              {state.report.rejected.length === 0 ? (
                <p className="text-xs text-emerald-300">Every row was accepted.</p>
              ) : (
                <div className="overflow-x-auto rounded-md border border-rose-900/50">
                  <table className="w-full text-left text-[11px]">
                    <caption className="sr-only">Rejected rows and why</caption>
                    <thead className="bg-rose-950/30 text-rose-300">
                      <tr>
                        <th scope="col" className="px-3 py-1.5 font-medium">
                          Row
                        </th>
                        <th scope="col" className="px-3 py-1.5 font-medium">
                          Camera id
                        </th>
                        <th scope="col" className="px-3 py-1.5 font-medium">
                          Problem
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {state.report.rejected.map((rejection) => (
                        <tr key={rejection.row} data-rejected-row={rejection.row}>
                          <td className="px-3 py-1.5 tabular-nums text-slate-300">
                            {rejection.row}
                          </td>
                          <td className="px-3 py-1.5 text-slate-400">
                            {rejection.externalId ?? '—'}
                          </td>
                          <td className="px-3 py-1.5">
                            <ul className="space-y-0.5">
                              {rejection.errors.map((problem, index) => (
                                <li
                                  key={`${problem.field}-${String(index)}`}
                                  className="text-slate-300"
                                >
                                  <span className="text-rose-400">{problem.field}</span>{' '}
                                  {problem.message}
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </form>
      </div>
    </div>
  );
}
