import { getSession } from '@/src/lib/session';
import { parseTraceQuery } from '@/src/lib/trace/query';
import { runTrace } from './actions';
import { TraceScreen } from './trace-screen';

export const dynamic = 'force-dynamic';

/**
 * The trace screen's server half.
 *
 * The first trace is run **here, from the URL**, so a deep link from an alert row — "trace this
 * vehicle" — arrives with the route already in the HTML rather than after a hydration round trip.
 * That is the whole point of making the URL the screen state: the link an operator clicks under
 * time pressure has to paint the answer, not a spinner.
 *
 * Everything after the first paint is a server action from the client component, for the reason
 * `trace-screen.tsx` explains: selecting a pin must not re-run a server component and remount the
 * WebGL context.
 */
export default async function TracePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseTraceQuery(await searchParams);

  const session = await getSession();
  if (session === null) return null;

  const initial = await runTrace(query);

  return (
    <TraceScreen
      initialQuery={query}
      initialTrace={initial.trace}
      initialError={initial.error}
      initialElapsedMs={initial.elapsedMs}
    />
  );
}
