/**
 * The evidence clock (D3-05).
 *
 * The question this screen exists to answer is the first one an investigating officer asks and the
 * one nobody in Gujarat can currently answer: **what footage can I still get, and how long do I
 * have?** Retention runs 7 days in some departments and 15 or more in others, so evidence expires
 * silently — report a crime on day 12 and there is no way to find out what survives.
 *
 * A server component with the query in the URL, so an availability search is a link an officer can
 * paste into a case note and a colleague opens the same answer.
 */
import { UserRole, can } from '@saakshi/shared';
import { getSession } from '@/src/lib/session';
import { loadEvidence } from './actions';
import { AvailabilityResults } from './availability-results';
import { EstateRetention } from './estate-retention';
import { PreservationForm } from './preservation-form';
import { PreservationQueue } from './preservation-queue';
import { RetentionLegend } from './retention-chip';
import type { AvailabilityQueryState } from './types';

export const dynamic = 'force-dynamic';

const FIELD =
  'h-9 rounded-md border border-slate-700 bg-slate-900 px-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400';
const LABEL = 'text-[11px] font-semibold tracking-wide text-slate-400 uppercase';

function one(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return (Array.isArray(value) ? (value[0] ?? '') : value).trim();
}

/** `YYYY-MM-DDTHH:mm` in IST, which is what a `datetime-local` input wants. */
function istLocalInput(at: Date): string {
  const shifted = new Date(at.getTime() + 330 * 60_000);
  return shifted.toISOString().slice(0, 16);
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

  const query: AvailabilityQueryState = {
    lat: one(params['lat']),
    lon: one(params['lon']),
    radiusM: one(params['radius_m']),
    at: one(params['at']),
    expiringSoonHours: one(params['expiring_soon_hours']),
  };

  const view = await loadEvidence(query);
  const now = new Date();

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Evidence availability</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            What footage still exists, and how long is left. Retention is set by each owning
            department — some keep 7 days, some 15 or more — so the answer differs camera by camera
            and nobody currently holds it in one place.
          </p>
        </div>
        <p className="text-xs text-slate-500 tabular-nums">{view.elapsedMs} ms</p>
      </div>

      {view.error !== null ? (
        <p
          role="alert"
          className="rounded-md border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-200"
        >
          {view.error}
        </p>
      ) : null}

      {/* The search lives in the URL: an availability answer is a thing an officer shares. */}
      <form method="GET" role="search" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Latitude</span>
          <input
            name="lat"
            defaultValue={query.lat}
            placeholder="23.0125"
            className={`${FIELD} w-32 font-mono`}
            data-testid="evidence-lat"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Longitude</span>
          <input
            name="lon"
            defaultValue={query.lon}
            placeholder="72.5661"
            className={`${FIELD} w-32 font-mono`}
            data-testid="evidence-lon"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Radius (m)</span>
          <input
            name="radius_m"
            defaultValue={query.radiusM}
            placeholder="500"
            className={`${FIELD} w-28 font-mono`}
            data-testid="evidence-radius"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Incident time (IST)</span>
          <input
            type="datetime-local"
            name="at"
            defaultValue={query.at}
            className={`${FIELD} w-56`}
            data-testid="evidence-at"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Warn within (h)</span>
          <input
            name="expiring_soon_hours"
            defaultValue={query.expiringSoonHours}
            placeholder={String(
              view.availability?.query.expiringSoonHours ?? 48,
            )}
            className={`${FIELD} w-28 font-mono`}
            data-testid="evidence-threshold"
          />
        </label>
        <button
          type="submit"
          className="h-9 rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-medium text-slate-100 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          data-action="evidence-search"
        >
          Check availability
        </button>
      </form>

      <AvailabilityResults availability={view.availability} />

      <RetentionLegend />

      <PreservationForm
        cameras={[
          ...(view.availability?.covering ?? []),
          ...(view.availability?.unassessable ?? []),
        ]}
        canRequest={can(role, 'registry:write')}
        defaultWindowStart={istLocalInput(new Date(now.getTime() - 60 * 60_000))}
        defaultWindowEnd={istLocalInput(now)}
      />

      <PreservationQueue queue={view.queue} />

      <EstateRetention summary={view.summary} />
    </div>
  );
}
