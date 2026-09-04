import { EmptyState } from '@/src/components/states';

/** Shell placeholder. The ticket puts every feature screen beyond the registry stub out of scope. */
export default function Page() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-100">Vehicle trace</h1>
      <EmptyState
        title="Not built yet"
        description="Identity linking, timeline and map land in D2-08. The shell, its navigation and its permissions are in place around it."
      />
    </div>
  );
}
