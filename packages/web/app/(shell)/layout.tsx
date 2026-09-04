import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getSession } from '@/src/lib/session';
import { ToastProvider } from '@/src/components/toast';
import { SideNav } from '@/src/components/side-nav';
import { Header } from '@/src/components/header';
import { UserRole } from '@saakshi/shared';

/**
 * The application shell every signed-in screen hangs on.
 *
 * The session is resolved **here**, once, by asking the API — so a revoked or expired token drops
 * the user at the login screen rather than rendering a shell around data they can no longer fetch.
 * Middleware has already checked the role hint; this is the authoritative check.
 *
 * Layout slots for later tickets:
 *   - left column  → `SideNav`, driven by the shared capability matrix
 *   - header       → `Header`: global camera search, badge, role, sign out
 *   - `{children}` → the page, inside a `<main id="main">` landmark with a skip link
 */
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (session === null) redirect('/login');

  const role = UserRole.parse(session.user.role);

  return (
    <ToastProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-sky-600 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to main content
      </a>
      {/* Fixed nav column, fluid content: holds at 1280px and uses the width at 1920px. */}
      <div className="grid min-h-dvh grid-cols-[15rem_minmax(0,1fr)]">
        <SideNav role={role} />
        <div className="flex min-w-0 flex-col">
          <Header user={session.user} />
          <main id="main" className="min-w-0 flex-1 px-8 py-6">
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
