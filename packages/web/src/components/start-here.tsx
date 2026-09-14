'use client';

/**
 * The "Start here" panel a judge meets on first login (D4-02).
 *
 * ## Why this exists at all
 *
 * A judge opens the URL cold, probably once, probably briefly, and lands on `/registry` — a dense
 * operational screen that assumes you already know what you are looking for. Everything the project
 * is actually being judged on is two clicks away and invisible from there: the trace that
 * reconstructs a vehicle's route, and the alert that explains why it fired. A control-room operator
 * learns those routes on day one. A judge has ninety seconds.
 *
 * So this is not decoration and not onboarding UX for its own sake — it is the difference between a
 * reviewer seeing the product and seeing a camera table.
 *
 * ## Dismissible, per browser, and never for an operator
 *
 * It is stored in `localStorage` rather than on the user, deliberately: the judge accounts are
 * shared credentials handed to a committee, and a dismissal by one reviewer must not remove the
 * panel for the next person opening the same login on another machine. `localStorage` can throw
 * (private windows, blocked site data), so every access is guarded and the panel simply shows.
 *
 * ## Role-aware, because the RBAC matrix is real
 *
 * An `auditor` holds neither `trace:run` nor `alerts:view`, and the web shell redirects them to
 * `/forbidden` rather than rendering a disabled screen (D2-07). Offering an auditor a "trace this
 * vehicle" link would therefore be an invitation to a dead end, so actions are filtered by
 * capability and the panel says plainly what this role cannot reach — which demonstrates the access
 * model instead of hiding it.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { can, type Capability, type UserRole } from '@saakshi/shared';

const DISMISS_KEY = 'saakshi.start-here.dismissed';

export interface StartHereAction {
  href: string;
  title: string;
  detail: string;
  capability?: Capability;
}

/**
 * The three suggested actions, in the order a judge should take them: see the estate, follow a
 * vehicle through it, then see what the system did on its own.
 *
 * `plate` and `camera` are supplied by the server component from the seeded demo state rather than
 * hardcoded here — a deep link to a plate that no longer exists is worse than no deep link.
 */
export function startHereActions(plate: string | null, cameraId: string | null): StartHereAction[] {
  return [
    {
      href: cameraId === null ? '/registry' : `/registry?camera=${cameraId}`,
      title: '1 · Inspect a camera on the map',
      detail:
        'The registry plots every camera that has coordinates and lists the ones that do not. Open a pin for its measured trust score — declared specification against what the stream actually delivers.',
    },
    {
      href:
        plate === null
          ? '/trace'
          : `/trace?plate=${encodeURIComponent(plate)}&purpose=${encodeURIComponent('Screening committee review')}`,
      title: '2 · Trace a vehicle across the estate',
      detail:
        'Every sighting of one registration, in order, with the route between them reconstructed and each segment labelled as observed or inferred. A purpose is required before the query runs, and the request is written to the audit chain.',
      capability: 'trace:run',
    },
    {
      href: '/alerts',
      title: '3 · Inspect an alert and why it fired',
      detail:
        'The queue the watchlist raised on its own. Open one for the full "why": the plate read, its confidence, the match type and distance, and the evidence crop the camera actually captured.',
      capability: 'alerts:view',
    },
  ];
}

export function StartHere({
  role,
  plate,
  cameraId,
}: {
  role: UserRole;
  plate: string | null;
  cameraId: string | null;
}) {
  // Shown by default, and hidden by the effect only if this browser has dismissed it.
  //
  // The obvious alternative - start hidden, reveal after checking localStorage - renders **nothing
  // on the server**, so the panel exists only after hydration. That makes it invisible to anything
  // that reads the HTML (curl, a link checker, a server-rendered smoke test) and it means the judge
  // this panel exists for sees the page paint without it and then reflow. Defaulting to shown costs
  // a dismissed panel one frame before it disappears, which is the cheaper mistake.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === '1') setDismissed(true);
    } catch {
      // Private window, or site data blocked. Showing the panel is the safe failure.
    }
  }, []);

  function dismiss(): void {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Nothing to do: the panel closes for this view either way.
    }
    setDismissed(true);
  }

  if (dismissed) return null;

  const all = startHereActions(plate, cameraId);
  const available = all.filter((a) => a.capability === undefined || can(role, a.capability));
  const withheld = all.filter((a) => a.capability !== undefined && !can(role, a.capability));

  return (
    <section
      aria-labelledby="start-here-heading"
      className="rounded-lg border border-sky-800/60 bg-sky-950/30 p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="start-here-heading" className="text-base font-semibold text-sky-100">
            Start here
          </h2>
          <p className="mt-1 text-sm text-slate-300">
            Three things worth seeing, in order. Signed in as <strong>{role}</strong>.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
        >
          Dismiss
        </button>
      </div>

      <ol className="mt-4 grid gap-3 md:grid-cols-3">
        {available.map((action) => (
          <li key={action.href} className="contents">
            <Link
              href={action.href}
              className="block rounded-md border border-slate-700 bg-slate-900/60 p-4 transition hover:border-sky-600 hover:bg-slate-900"
            >
              <span className="block text-sm font-semibold text-sky-200">{action.title}</span>
              <span className="mt-1.5 block text-xs leading-relaxed text-slate-400">
                {action.detail}
              </span>
            </Link>
          </li>
        ))}
      </ol>

      {withheld.length > 0 && (
        <p className="mt-4 border-t border-slate-800 pt-3 text-xs text-slate-400">
          The <strong>{role}</strong> role cannot reach{' '}
          {withheld.map((a) => a.title.replace(/^\d+ · /, '')).join(' or ')} — that is the access
          matrix working, not a fault. Sign in with the operator credential to see those.
        </p>
      )}
    </section>
  );
}
