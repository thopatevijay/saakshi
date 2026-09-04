/**
 * Loading, empty and error states as first-class components.
 *
 * The ticket calls them out because they are the difference between a demo and an operational
 * system: a control-room screen that shows a blank panel when a query returns nothing, or a raw
 * stack trace when the API is down, tells an officer nothing about what to do next. Each of these
 * says what happened and what to do.
 */
import type { ReactNode } from 'react';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 text-sm text-slate-400"
    >
      <span
        aria-hidden="true"
        className="size-4 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400"
      />
      <span>{label}…</span>
    </div>
  );
}

/** Skeleton rows. Sized to the table they stand in for, so the layout does not jump on load. */
export function LoadingPanel({ rows = 6, label }: { rows?: number; label?: string }) {
  return (
    <section className="space-y-4" aria-busy="true">
      <Spinner {...(label === undefined ? {} : { label })} />
      <div className="space-y-2" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="h-11 animate-pulse rounded-md bg-slate-800/60" />
        ))}
      </div>
    </section>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-dashed border-slate-700 bg-slate-900/40 px-6 py-12 text-center">
      <h2 className="text-base font-semibold text-slate-200">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">{description}</p>
      {action === undefined ? null : <div className="mt-6 flex justify-center">{action}</div>}
    </section>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
}: {
  title?: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <section
      role="alert"
      className="rounded-lg border border-rose-900/60 bg-rose-950/30 px-6 py-8 text-center"
    >
      <h2 className="text-base font-semibold text-rose-200">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-rose-300/80">{description}</p>
      {onRetry === undefined ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 rounded-md border border-rose-700 px-4 py-2 text-sm font-medium text-rose-100 hover:bg-rose-900/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400"
        >
          Try again
        </button>
      )}
    </section>
  );
}
