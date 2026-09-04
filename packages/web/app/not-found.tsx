import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold text-slate-100">Page not found</h1>
        <p className="mt-3 text-sm text-slate-400">That address does not exist in SAAKSHI.</p>
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
