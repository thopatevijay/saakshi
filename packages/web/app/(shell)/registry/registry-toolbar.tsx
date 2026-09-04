'use client';

/**
 * The toolbar — **Model 1's three onboarding paths, visible in the UI**, plus export.
 *
 * The three paths are deliberately side by side rather than hidden behind one "Add" menu, because
 * they answer three different situations and a department needs to see that all three exist:
 *
 *   **Catalogue sync** — the estate already exists in a VMS or an upstream list. Pull it.
 *   **Bulk import** — the estate exists in a spreadsheet, which is the real-world case.
 *   **Add camera** — one new installation.
 *
 * Export closes the loop: the CSV columns match the import fixture, so a department can be handed
 * their own data back, fix it in a spreadsheet, and re-import it as an update rather than a
 * duplicate set. That round trip is the acceptance criterion, and it is what makes the registry a
 * tool a department can actually maintain instead of a one-way sink.
 *
 * Buttons are gated on the capability matrix as a **courtesy**: the API re-checks against the
 * signed token, so hiding a button prevents a pointless 403, never an unauthorised write.
 */
import { useState, useTransition } from 'react';
import { useToast } from '@/src/components/toast';
import { syncCatalogue } from './actions';

export function RegistryToolbar({
  canImport,
  canWrite,
  onOpenImport,
  onOpenManualAdd,
  exportHref,
}: {
  canImport: boolean;
  canWrite: boolean;
  onOpenImport: () => void;
  onOpenManualAdd: () => void;
  exportHref: string;
}) {
  const { notify } = useToast();
  const [pending, startTransition] = useTransition();
  const [confirmingSync, setConfirmingSync] = useState(false);

  const runSync = () => {
    setConfirmingSync(false);
    startTransition(() => {
      void syncCatalogue().then((result) => {
        if (result.error !== null) {
          notify(result.error, 'error');
          return;
        }
        const report = result.report;
        if (report === null) return;
        notify(
          `Catalogue sync: ${String(report.fetched)} fetched · ${String(report.added)} added · ${String(report.updated)} updated · ${String(report.unchanged)} unchanged · ${String(report.wentAbsent)} went absent`,
          'success',
        );
      });
    });
  };

  const button =
    'rounded-md border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-sky-800 hover:text-sky-200 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canImport ? (
        confirmingSync ? (
          <span className="flex items-center gap-2 rounded-md border border-amber-800 bg-amber-950/30 px-3 py-1.5 text-xs text-amber-200">
            Reach the upstream catalogue now?
            <button type="button" onClick={runSync} className="font-medium underline">
              Yes, sync
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingSync(false);
              }}
              className="text-amber-400/80 underline"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            disabled={pending}
            data-action="sync-catalogue"
            onClick={() => {
              setConfirmingSync(true);
            }}
            title="Pulls the upstream catalogue. Never runs on page load — it reaches an external host."
            className={button}
          >
            {pending ? 'Syncing…' : 'Sync catalogue'}
          </button>
        )
      ) : null}

      {canImport ? (
        <button type="button" data-action="bulk-import" onClick={onOpenImport} className={button}>
          Bulk import
        </button>
      ) : null}

      {canWrite ? (
        <button type="button" data-action="manual-add" onClick={onOpenManualAdd} className={button}>
          Add camera
        </button>
      ) : null}

      <span className="mx-1 h-4 w-px bg-slate-800" aria-hidden="true" />

      {/* A real navigation, not a fetch: the token is httpOnly, so the download is proxied by the
          app's own route handler with the cookie attached server-side. */}
      <a href={`${exportHref}?format=csv`} data-action="export-csv" download className={button}>
        Export CSV
      </a>
      <a href={`${exportHref}?format=json`} data-action="export-json" download className={button}>
        Export JSON
      </a>
    </div>
  );
}
