import { Suspense } from 'react';
import type { Metadata } from 'next';
import { LoginForm } from './login-form';
import { Spinner } from '@/src/components/states';

export const metadata: Metadata = { title: 'Sign in · SAAKSHI' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <header className="mb-8 text-center">
          <p className="text-xs uppercase tracking-[0.25em] text-slate-400">साक्षी · the witness</p>
          <h1 className="mt-2 text-2xl font-semibold text-slate-100">SAAKSHI</h1>
          <p className="mt-2 text-sm text-slate-400">
            Camera registry, federation and video analytics
          </p>
        </header>
        <Suspense fallback={<Spinner label="Preparing sign in" />}>
          <LoginForm next={next ?? '/registry'} />
        </Suspense>
      </div>
    </main>
  );
}
