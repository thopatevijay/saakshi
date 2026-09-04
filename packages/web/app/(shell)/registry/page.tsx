import { getSession } from '@/src/lib/session';
import { apiClient } from '@/src/lib/api/client';
import { EmptyState, ErrorState } from '@/src/components/states';
import { RegistryTable } from './registry-table';
import { can, UserRole } from '@saakshi/shared';

export const dynamic = 'force-dynamic';

/**
 * Registry stub (D1-08 owns the map and the full screen).
 *
 * Data is fetched **server-side through the generated client**, so the browser never holds a token
 * and no response shape is hand-typed. Every one of the three states the ticket asks for is here:
 * error when the API refuses, empty when it returns nothing, and the table when it does not.
 */
export default async function RegistryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const session = await getSession();
  if (session === null) return null;

  const role = UserRole.parse(session.user.role);
  const { data, error } = await apiClient(session.token).GET('/api/v1/cameras', {
    params: { query: { limit: 50, ...(q === undefined || q === '' ? {} : { q }) } },
  });

  if (error !== undefined || data === undefined) {
    return (
      <ErrorState description="The registry could not be loaded. The API may be unreachable or your session may have expired." />
    );
  }

  const cameras = data.data;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Camera registry</h1>
          <p className="mt-1 text-sm text-slate-400">
            {q === undefined || q === ''
              ? `${String(cameras.length)} camera${cameras.length === 1 ? '' : 's'}`
              : `${String(cameras.length)} matching “${q}”`}
            {can(role, 'registry:write') ? '' : ' · read-only for your role'}
          </p>
        </div>
      </div>

      {cameras.length === 0 ? (
        <EmptyState
          title={q === undefined || q === '' ? 'No cameras onboarded yet' : 'No cameras match'}
          description={
            q === undefined || q === ''
              ? 'Run the catalogue sync to import the estate, or onboard a camera by hand.'
              : 'Try a camera id, a name fragment, or a district.'
          }
        />
      ) : (
        <RegistryTable
          cameras={cameras}
          canWrite={can(role, 'registry:write')}
          canDelete={can(role, 'registry:delete')}
        />
      )}
    </div>
  );
}
