import { CameraSearch } from './camera-search';
import { logout } from '@/app/login/actions';
import type { SessionUser } from '@/src/lib/api/client';

/** Global search, who is signed in, and the way out. */
export function Header({ user }: { user: SessionUser }) {
  return (
    <header className="flex items-center gap-6 border-b border-slate-800 bg-slate-900/40 px-8 py-3">
      <CameraSearch />
      <div className="ml-auto flex items-center gap-4">
        <p className="text-right text-sm leading-tight">
          <span className="block font-medium text-slate-200">{user.name}</span>
          <span className="block text-xs text-slate-500">
            {user.badgeNo} · <span className="uppercase tracking-wide">{user.role}</span>
            {user.departmentCode === null ? '' : ` · ${user.departmentCode}`}
          </span>
        </p>
        <form action={logout}>
          <button
            type="submit"
            className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
