'use client';

/**
 * Toast and confirm — the two patterns every mutating action in this app uses.
 *
 * A destructive action in a police system needs a deliberate second step, and the result needs to be
 * visible without hunting for it. `window.confirm` would do neither: it is unstyled, unlabelled to a
 * screen reader in any useful way, and it blocks the whole tab.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  notify: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

const TONE_CLASS: Record<ToastTone, string> = {
  success: 'border-emerald-800 bg-emerald-950/80 text-emerald-100',
  error: 'border-rose-800 bg-rose-950/80 text-rose-100',
  info: 'border-slate-700 bg-slate-900/90 text-slate-100',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, message }]);
    setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const api = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Polite, not assertive: a confirmation should not interrupt whatever is being read. */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-6 right-6 z-50 flex w-80 flex-col gap-2"
      >
        {toasts.map((toast) => (
          <p
            key={toast.id}
            className={`pointer-events-auto rounded-md border px-4 py-3 text-sm shadow-lg ${TONE_CLASS[toast.tone]}`}
          >
            {toast.message}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function ConfirmButton({
  label,
  confirmLabel,
  question,
  onConfirm,
  destructive = false,
}: {
  label: string;
  confirmLabel: string;
  question: string;
  onConfirm: () => void | Promise<void>;
  destructive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className={`rounded-md border px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 ${
          destructive
            ? 'border-rose-800 text-rose-200 hover:bg-rose-950/50 focus-visible:outline-rose-400'
            : 'border-slate-700 text-slate-200 hover:bg-slate-800 focus-visible:outline-sky-400'
        }`}
      >
        {label}
      </button>
    );
  }

  return (
    <span role="group" aria-label={question} className="inline-flex items-center gap-2">
      <span className="text-sm text-slate-300">{question}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void Promise.resolve(onConfirm()).finally(() => {
            setBusy(false);
            setOpen(false);
          });
        }}
        className="rounded-md border border-rose-700 bg-rose-900/40 px-3 py-1.5 text-sm font-medium text-rose-100 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400"
      >
        {busy ? 'Working…' : confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
        }}
        className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      >
        Cancel
      </button>
    </span>
  );
}
