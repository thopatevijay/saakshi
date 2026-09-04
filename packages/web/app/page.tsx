import { AdapterKind } from '@saakshi/shared';

/**
 * Bootstrap page only. The real shell — auth, RBAC and layout — is D1-07.
 * It renders one value from `@saakshi/shared` to prove the workspace link resolves at build time.
 */
export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">साक्षी · the witness</p>
      <h1 className="mt-2 text-3xl font-semibold">SAAKSHI</h1>
      <p className="mt-4 text-slate-400">
        CCTV registry, federation fabric and video analytics. Bootstrap shell — the operator UI
        lands in D1-07.
      </p>
      <dl className="mt-10 space-y-2 text-sm">
        <div className="flex gap-3">
          <dt className="w-40 text-slate-500">API</dt>
          <dd className="text-slate-300">
            <code>http://localhost:4000/health</code>
          </dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-40 text-slate-500">Adapters specified</dt>
          <dd className="text-slate-300">
            <code>{AdapterKind.options.join(' · ')}</code>
          </dd>
        </div>
      </dl>
    </main>
  );
}
