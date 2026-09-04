/**
 * Route guard.
 *
 * Two jobs, both about **redirecting rather than exploding** — the acceptance criterion is explicit
 * that a direct URL to a forbidden route must redirect, not 500:
 *
 *  1. No session → `/login`, carrying where you were headed so the redirect survives the round trip.
 *  2. A session without the capability the route needs → `/forbidden`.
 *
 * This runs on the readable role cookie, which is a **hint**. It is user-editable by definition, so
 * it is deliberately not the security boundary: every capability it implies is re-checked by the
 * API against a signed token. Editing the cookie gets you a menu item and a 403.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { UserRole, can, capabilityForPath } from '@saakshi/shared';

const TOKEN_COOKIE = 'saakshi_session';
const ROLE_COOKIE = 'saakshi_role';

/** Reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = ['/login', '/forbidden'];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const token = request.cookies.get(TOKEN_COOKIE)?.value;
  if (token === undefined || token === '') {
    const login = new URL('/login', request.url);
    // So a deep link survives the detour through the login screen.
    login.searchParams.set('next', pathname);
    return NextResponse.redirect(login);
  }

  const capability = capabilityForPath(pathname);
  if (capability === undefined) return NextResponse.next();

  const role = UserRole.safeParse(request.cookies.get(ROLE_COOKIE)?.value);
  // An unreadable role hint is not an error — send them somewhere that explains itself rather than
  // throwing. The API will refuse the underlying data either way.
  if (!role.success || !can(role.data, capability)) {
    const forbidden = new URL('/forbidden', request.url);
    forbidden.searchParams.set('path', pathname);
    return NextResponse.redirect(forbidden);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next's own assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
