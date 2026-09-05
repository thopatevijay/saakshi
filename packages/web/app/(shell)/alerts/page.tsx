import { UserRole, can } from '@saakshi/shared';
import { getSession } from '@/src/lib/session';
import { parseAlertQuery } from '@/src/lib/alerts/query';
import { loadAlerts, loadFilterOptions } from './actions';
import { AlertsScreen } from './alerts-screen';

export const dynamic = 'force-dynamic';

/**
 * The alert queue's server half.
 *
 * The first page is fetched **here, from the URL**, so a queue opened cold — or a filtered link
 * pasted into a shift handover — arrives with the alerts already in the HTML rather than after a
 * hydration round trip. That is what makes the three-second test measure the screen instead of
 * measuring a spinner, and it is the same bargain `/trace` struck for its deep link.
 *
 * Everything after the first paint is a server action or the SSE proxy: the token stays in the
 * httpOnly cookie and never reaches browser JavaScript.
 */
export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseAlertQuery(await searchParams);

  const session = await getSession();
  if (session === null) return null;
  const role = UserRole.parse(session.user.role);

  const [page, options] = await Promise.all([loadAlerts(query), loadFilterOptions()]);

  return (
    <AlertsScreen
      initialQuery={query}
      initialAlerts={page.alerts}
      initialCursor={page.nextCursor}
      initialError={page.error}
      disclaimer={page.disclaimer}
      options={options}
      // Client-side gating is a courtesy that keeps an operator out of a 403, never the boundary:
      // the API re-checks every capability against the signed token.
      mayAct={can(role, 'alerts:acknowledge')}
      mayTrace={can(role, 'trace:run')}
      actorId={session.user.id}
    />
  );
}
