'use client';

import { useActionState } from 'react';
import { login, type LoginState } from './actions';

const INITIAL: LoginState = { error: null };

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(login, INITIAL);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next} />

      <div>
        <label htmlFor="badgeNo" className="block text-sm font-medium text-slate-300">
          Badge number
        </label>
        <input
          id="badgeNo"
          name="badgeNo"
          autoComplete="username"
          required
          placeholder="GP-OPR-1042"
          aria-describedby={state.error === null ? undefined : 'login-error'}
          className="mt-1.5 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 placeholder:text-slate-400 focus-visible:border-sky-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-500"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-slate-300">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-describedby={state.error === null ? undefined : 'login-error'}
          className="mt-1.5 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus-visible:border-sky-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-500"
        />
      </div>

      {/* role="alert" so a screen reader announces the failure without the user re-reading the form. */}
      {state.error === null ? null : (
        <p
          id="login-error"
          role="alert"
          className="rounded-md border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-200"
        >
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-sky-700 px-4 py-2.5 font-medium text-white hover:bg-sky-600 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
