/**
 * Session storage and retrieval.
 *
 * The bearer token lives in an **httpOnly** cookie, so browser JavaScript cannot read it: an XSS in
 * any dependency cannot exfiltrate a session. Server components and route handlers read the cookie
 * and forward the token to the API.
 *
 * The role is stored in a **second, readable** cookie purely so middleware can gate a route without
 * a network round trip on every navigation. That cookie is a *hint*, never an authority — it is
 * user-editable by definition, and every capability it implies is re-checked by the API, which
 * verifies the signed token. Editing it buys you a menu item and a 403.
 */
import { cookies } from 'next/headers';
import { UserRole, type Capability, can } from '@saakshi/shared';
import { apiClient, type SessionUser } from './api/client';

export const TOKEN_COOKIE = 'saakshi_session';
export const ROLE_COOKIE = 'saakshi_role';

export interface Session {
  token: string;
  user: SessionUser;
}

/**
 * The signed-in user, or `null`.
 *
 * Resolved by asking the API rather than by decoding the cookie: a token can be expired, revoked or
 * belong to a deactivated officer, and only the server that verifies signatures knows which. D1-02
 * made `authenticate(db)` check the subject against `users WHERE active` for exactly this reason —
 * deactivating an officer must actually revoke their access.
 */
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (token === undefined || token === '') return null;

  const { data, error } = await apiClient(token).GET('/api/v1/auth/me');
  if (error !== undefined || data === undefined) return null;

  return { token, user: data };
}

/** The role hint from the readable cookie. Middleware-only; never a security decision. */
export async function getRoleHint(): Promise<UserRole | null> {
  const raw = (await cookies()).get(ROLE_COOKIE)?.value;
  const parsed = UserRole.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function sessionCan(capability: Capability): Promise<boolean> {
  const session = await getSession();
  if (session === null) return false;
  const role = UserRole.safeParse(session.user.role);
  return role.success && can(role.data, capability);
}
