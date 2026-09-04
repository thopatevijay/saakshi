import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Not permitted · SAAKSHI' };

/**
 * Where the middleware sends a signed-in user who reaches a route their role cannot use.
 *
 * A page rather than a 403 body, because the acceptance criterion is that a forbidden direct URL
 * **redirects rather than 500s** — and because an officer who followed a colleague's link deserves
 * to be told what happened and given a way back, not a blank error.
 */
export default async function ForbiddenPage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string }>;
}) {
  const { path } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-amber-500">
          Not permitted
        </p>
        <h1 className="mt-3 text-2xl font-semibold text-slate-100">
          Your role cannot open this page
        </h1>
        <p className="mt-3 text-sm text-slate-400">
          {path === undefined
            ? 'This area is restricted to other roles.'
            : `Access to ${path} is restricted to other roles.`}{' '}
          If you need it, ask an administrator to review your permissions.
        </p>
        <Link
          href="/registry"
          className="mt-8 inline-block rounded-md border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          Back to Registry
        </Link>
      </div>
    </main>
  );
}
