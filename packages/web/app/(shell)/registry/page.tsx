import { getSession } from '@/src/lib/session';
import { apiClient } from '@/src/lib/api/client';
import { EmptyState, ErrorState } from '@/src/components/states';
import { RegistryScreen } from './registry-screen';
import { loadCameras } from './actions';
import { parseRegistryState } from '@/src/lib/registry/query';
import { can, UserRole } from '@saakshi/shared';

export const dynamic = 'force-dynamic';

/**
 * The registry screen's server half.
 *
 * It does exactly two things: resolve who is asking, and fetch **the first page from the URL** so
 * the cold load has data in the initial HTML. Every later fetch is a server action from the client
 * component — see `registry-screen.tsx` for why.
 *
 * Doing the first fetch here rather than in a `useEffect` is what keeps the AC 9 number honest: a
 * client-side first fetch would put a full round trip after hydration, and "dashboard load" would
 * measure an empty page arriving quickly.
 *
 * Data is fetched **server-side through the generated client**, so the browser never holds a token
 * and no response shape is hand-typed.
 */
export default async function RegistryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { filters, layers, selected } = parseRegistryState(params);

  const session = await getSession();
  if (session === null) return null;
  const role = UserRole.parse(session.user.role);

  const [page, departments] = await Promise.all([
    loadCameras(filters),
    apiClient(session.token).GET('/api/v1/departments'),
  ]);

  if (page.error !== null) {
    return (
      <ErrorState description="The registry could not be loaded. The API may be unreachable or your session may have expired." />
    );
  }

  const departmentOptions = (departments.data?.data ?? []).map((department) => ({
    id: department.id,
    code: department.code,
  }));

  // An empty *estate* is a different situation from an empty *result*, and the two need different
  // advice: one says how to onboard, the other says to widen the filter.
  const filtered = Object.keys(filters).some((key) => key !== 'limit');
  if (page.cameras.length === 0 && !filtered) {
    return (
      <div className="space-y-6">
        <h1 className="text-xl font-semibold text-slate-100">Camera registry</h1>
        <EmptyState
          title="No cameras onboarded yet"
          description="Run the catalogue sync to import an existing estate, import a CSV, or onboard a camera by hand. All three paths appear on the toolbar once there is something to show."
        />
      </div>
    );
  }

  return (
    <RegistryScreen
      initialCameras={page.cameras}
      initialCapped={page.capped}
      initialElapsedMs={page.elapsedMs}
      initialFilters={filters}
      initialLayers={layers}
      initialSelected={selected}
      departments={departmentOptions}
      canWrite={can(role, 'registry:write')}
      canImport={can(role, 'registry:import')}
      canDelete={can(role, 'registry:delete')}
    />
  );
}
