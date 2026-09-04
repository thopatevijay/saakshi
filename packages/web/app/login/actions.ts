'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { publicApi } from '@/src/lib/api/client';
import { ROLE_COOKIE, TOKEN_COOKIE } from '@/src/lib/session';

export interface LoginState {
  error: string | null;
}

/**
 * Exchanges credentials for a session.
 *
 * The token goes into an **httpOnly** cookie and never reaches browser JavaScript. The role goes
 * into a readable one so middleware can gate a route without a network round trip — a hint, not an
 * authority; see `middleware.ts`.
 */
/**
 * A text field from the form, or `''`.
 *
 * `FormData.get` returns `File | string | null`, and `String(file)` is `"[object File]"` — which
 * would sail through a length check and be sent to the API as a password. Narrowing is the fix, not
 * a cast.
 */
function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const badgeNo = field(formData, 'badgeNo').trim();
  const password = field(formData, 'password');
  const nextRaw = field(formData, 'next');
  const next = nextRaw === '' ? '/registry' : nextRaw;

  if (badgeNo === '' || password === '') {
    return { error: 'Enter your badge number and password.' };
  }

  const { data, error } = await publicApi().POST('/api/v1/auth/login', {
    body: { badgeNo, password },
  });

  if (error !== undefined || data === undefined) {
    // The API deliberately gives one answer for an unknown badge, a deactivated account and a wrong
    // password. Surfacing anything more specific here would undo that.
    return { error: 'Badge number or password is incorrect.' };
  }

  const jar = await cookies();
  const options = {
    path: '/',
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: data.expiresInSeconds,
  };
  jar.set(TOKEN_COOKIE, data.token, { ...options, httpOnly: true });
  jar.set(ROLE_COOKIE, data.user.role, { ...options, httpOnly: false });

  // Only ever redirect to a path on this origin — an open redirect through `?next=` would let a
  // phishing link bounce a freshly authenticated officer to somebody else's site.
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/registry');
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(TOKEN_COOKIE);
  jar.delete(ROLE_COOKIE);
  redirect('/login');
}
