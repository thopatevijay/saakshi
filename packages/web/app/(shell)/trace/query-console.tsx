'use client';

/**
 * The natural-language query console (D3-09).
 *
 * It sits **above** the manual filter on the trace screen rather than on a route of its own, and
 * that placement is the design. The ticket's degradation requirement — "`none` degrades to the
 * manual filter UI with no broken screens" — is not a fallback we built; it is what this screen
 * already is. Turn the compiler off and the box explains itself and steps aside, and the officer is
 * looking at the deterministic filter that was always the primary interface.
 *
 * **The order of operations is visible, and that is deliberate.** Ask → the filter appears as chips
 * → the officer removes anything the model invented → *then* Run. There is no path that compiles
 * and runs in one press, because the API has no endpoint that would accept one: `/query/run` takes
 * a filter and has no natural-language field at all.
 *
 * The results deliberately reuse the trace screen's sighting views. A compiled query is a search
 * over the same sightings, with the same claims about what is observed and what is inferred, and a
 * second set of vocabulary for the same evidence would be a second thing to keep honest.
 */
import { useState, useTransition } from 'react';
import {
  EMPTY_CONSOLE_STATE,
  canCompile,
  canRun,
  degradation,
  emptyReasonText,
  isEdited,
  removeChip,
  toChips,
  type ChipId,
  type CompileOutcomePayload,
  type ConsoleState,
} from '@/src/lib/query-console/console';
import { compileQuestion, runCompiledQuery } from './actions';
import type { QueryRunPayload } from './types';

const BUTTON =
  'rounded-md border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-sky-800 hover:text-sky-200 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400';
const FIELD =
  'rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-400';
const CHIP =
  'inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] leading-tight font-semibold tracking-wide';

export interface QueryConsoleProps {
  /** Stated once on the screen and shared with the manual trace, so it is asked for exactly once. */
  purpose: string;
  caseRef: string | null;
}

export function QueryConsole({ purpose, caseRef }: QueryConsoleProps) {
  const [state, setState] = useState<ConsoleState>({ ...EMPTY_CONSOLE_STATE, purpose, caseRef });
  const [outcome, setOutcome] = useState<CompileOutcomePayload | null>(null);
  const [result, setResult] = useState<QueryRunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The purpose lives on the trace screen's own form; this component follows it rather than asking
  // for it twice. D3-04: it is never defaulted here or anywhere else.
  const current: ConsoleState = { ...state, purpose, caseRef };
  const view = degradation(outcome);

  const compile = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canCompile(current)) return;
    startTransition(() => {
      void (async () => {
        setError(null);
        setResult(null);
        const next = await compileQuestion(current);
        if (next.error !== null) {
          setError(next.error);
          return;
        }
        setOutcome(next.outcome);
        setState((s) => ({
          ...s,
          compiled: next.outcome?.dsl ?? null,
          draft: next.outcome?.dsl ?? null,
        }));
      })();
    });
  };

  const run = () => {
    if (!canRun(current)) return;
    startTransition(() => {
      void (async () => {
        setError(null);
        const next = await runCompiledQuery(current);
        if (next.error !== null) {
          setError(next.error);
          return;
        }
        setResult(next.result);
      })();
    });
  };

  const drop = (id: ChipId) => {
    setState((s) => (s.draft === null ? s : { ...s, draft: removeChip(s.draft, id) }));
    // The previous result belongs to the previous filter. Leaving it on screen beside an edited
    // filter would invite reading one as the answer to the other.
    setResult(null);
  };

  const chips = current.draft === null ? [] : toChips(current.draft, current.compiled);
  const edited = isEdited(current);

  return (
    <section
      className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4"
      aria-label="Plain-English query"
      data-testid="query-console"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-200">Ask in plain English</h2>
        {outcome !== null && outcome.ok ? (
          <p className="text-[11px] text-slate-500 tabular-nums">
            compiled by {outcome.provider}
            {outcome.model === null ? '' : ` · ${outcome.model}`} · {outcome.tookMs} ms
          </p>
        ) : null}
      </div>

      <form onSubmit={compile} role="search" className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[22rem] flex-1 flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            Question
          </span>
          <input
            name="question"
            value={current.text}
            data-testid="query-text"
            placeholder="White cars that passed cam01 after 02:00 and later appeared near Adalaj"
            onChange={(e) => setState((s) => ({ ...s, text: e.target.value }))}
            className={`${FIELD} w-full`}
          />
        </label>
        <button
          type="submit"
          data-action="compile"
          disabled={pending || !canCompile(current)}
          className={`${BUTTON} h-9`}
        >
          {pending ? 'Compiling…' : 'Compile filter'}
        </button>
      </form>

      {!canCompile(current) && current.text.trim() !== '' ? (
        <p className="text-[11px] text-amber-300/80">
          State a purpose in the trace form below before searching — it is recorded in the audit
          chain against your badge.
        </p>
      ) : null}

      {/* The degraded state. A notice when there is simply no model configured; a warning when one
          was configured and something went wrong. Never an error boundary, never a blank screen. */}
      {view.mode === 'manual' && view.message !== null ? (
        <div
          role="status"
          data-testid="query-degraded"
          className={
            view.tone === 'warning'
              ? 'rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200'
              : 'rounded-md border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-300'
          }
        >
          <p>{view.message}</p>
          {view.issues.length > 0 ? (
            <ul className="mt-1 list-inside list-disc text-[11px] text-amber-300/80">
              {view.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {error !== null ? (
        <p
          role="alert"
          className="rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-200"
        >
          {error}
        </p>
      ) : null}

      {/* The filter, before it runs. This block is the acceptance criterion made visible. */}
      {current.draft !== null ? (
        <div className="space-y-2" data-testid="query-filter">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
              Filter — review and edit before running
            </span>
            {edited ? (
              <span className={`${CHIP} border-sky-800 bg-sky-950/50 text-sky-200`}>edited</span>
            ) : null}
          </div>

          {chips.length === 0 ? (
            <p className="text-xs text-amber-300/80">
              This filter constrains nothing and would return every sighting in the window. That is
              usually a compile that went wrong rather than the question that was asked.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {chips.map((chip) => (
                <li key={chip.id}>
                  <span
                    className={`${CHIP} ${
                      chip.origin === 'edited'
                        ? 'border-sky-800 bg-sky-950/50 text-sky-200'
                        : 'border-slate-700 bg-slate-900/70 text-slate-200'
                    }`}
                  >
                    <span className="text-slate-400">{chip.label}</span>
                    <span className="font-mono tracking-wide">{chip.value}</span>
                    <button
                      type="button"
                      aria-label={`Remove the ${chip.label} constraint`}
                      data-action={`drop-${chip.id}`}
                      onClick={() => drop(chip.id)}
                      className="ml-0.5 rounded px-1 text-slate-500 hover:text-rose-300 focus-visible:outline-1 focus-visible:outline-sky-400"
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            data-action="run"
            disabled={pending || !canRun(current)}
            onClick={run}
            className={`${BUTTON} h-9`}
          >
            {pending ? 'Running…' : 'Run this filter'}
          </button>
        </div>
      ) : null}

      {result !== null ? <QueryResult result={result} /> : null}
    </section>
  );
}

/**
 * The result.
 *
 * The SQL that actually ran is shown, with `$1`, `$2` where the values went. That is not developer
 * garnish — it is the visible form of the claim this whole feature rests on: the model wrote the
 * filter, and the filter became bound parameters, and nothing the model produced became SQL.
 */
function QueryResult({ result }: { result: QueryRunPayload }) {
  const empty = emptyReasonText(result.emptyReason);
  return (
    <div className="space-y-2 border-t border-slate-800 pt-3" data-testid="query-result">
      <p className="text-xs text-slate-400 tabular-nums">
        {result.rowCount} {result.entity} · {result.tookMs} ms
      </p>

      {result.unknownCameras.length > 0 || result.unknownDistricts.length > 0 ? (
        <p className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          Not in this estate:{' '}
          <span className="font-mono">
            {[...result.unknownCameras, ...result.unknownDistricts].join(', ')}
          </span>
          . Remove that constraint, or correct it — until then the filter can only return nothing.
        </p>
      ) : null}

      {empty !== null ? <p className="text-xs text-slate-400">{empty}</p> : null}

      {result.resolvedPlates.length > 0 ? (
        <p className="text-[11px] text-slate-500">
          Registrations matched:{' '}
          {result.resolvedPlates
            .map((p) => `${p.plate} (${p.matchType}, ${p.distance})`)
            .join(' · ')}
        </p>
      ) : null}

      {result.sightings.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-xs">
            <thead className="text-[11px] tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="py-1 pr-3">time</th>
                <th className="py-1 pr-3">camera</th>
                <th className="py-1 pr-3">class</th>
                <th className="py-1 pr-3">colour</th>
                <th className="py-1 pr-3">plate</th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              {result.sightings.slice(0, 50).map((s) => (
                <tr
                  key={s.sightingId}
                  className="border-t border-slate-800/60"
                  data-row={s.sightingId}
                >
                  <td className="py-1 pr-3 font-mono tabular-nums">{s.ts}</td>
                  <td className="py-1 pr-3">{s.cameraExternalId}</td>
                  <td className="py-1 pr-3">{s.class}</td>
                  <td className="py-1 pr-3">{s.vehicleColor ?? '—'}</td>
                  <td className="py-1 pr-3 font-mono">{s.plateNormalized ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <details className="text-[11px] text-slate-500">
        <summary className="cursor-pointer hover:text-slate-300">
          The SQL that ran — every value is a bound parameter
        </summary>
        <pre className="mt-1 overflow-x-auto rounded border border-slate-800 bg-slate-950/60 p-2 font-mono text-[10px] text-slate-400">
          {result.sqlPreview}
        </pre>
      </details>

      <p className="text-[11px] text-slate-500">{result.disclaimer}</p>
    </div>
  );
}
