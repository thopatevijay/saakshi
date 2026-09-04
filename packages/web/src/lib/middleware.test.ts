/**
 * Middleware tests.
 *
 * The acceptance criterion is explicit: **a direct URL to a forbidden route must redirect, not
 * 500.** So every case here asserts a redirect status and a destination — never merely that "it
 * didn't work". A guard that throws is a guard that fails the ticket.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

function request(pathname: string, cookies: Record<string, string> = {}): NextRequest {
  const req = new NextRequest(new URL(`http://localhost:3000${pathname}`));
  for (const [name, value] of Object.entries(cookies)) req.cookies.set(name, value);
  return req;
}

const signedIn = (role: string) => ({ saakshi_session: 'a.b.c', saakshi_role: role });

describe('unauthenticated access', () => {
  it('redirects to login and remembers where you were going', () => {
    const res = middleware(request('/registry'));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login');
    // A deep link has to survive the detour, or every shared URL lands on the registry.
    expect(location.searchParams.get('next')).toBe('/registry');
  });

  it('lets the login and forbidden pages through', () => {
    for (const path of ['/login', '/forbidden']) {
      expect(middleware(request(path)).headers.get('location')).toBeNull();
    }
  });
});

describe('a signed-in user reaching a route their role cannot use', () => {
  it('redirects to /forbidden rather than throwing — the acceptance criterion', () => {
    // The auditor has no `video:view`.
    const res = middleware(request('/video-wall', signedIn('auditor')));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/forbidden');
    expect(location.searchParams.get('path')).toBe('/video-wall');
  });

  it.each([
    ['auditor', '/trace'],
    ['auditor', '/alerts'],
    ['auditor', '/video-wall'],
  ])('%s is refused %s', (role, path) => {
    const res = middleware(request(path, signedIn(role)));
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/forbidden');
  });

  it('lets a role through to a route it does hold', () => {
    const allowed: [string, string][] = [
      ['auditor', '/audit'],
      ['auditor', '/registry'],
      ['operator', '/video-wall'],
      ['operator', '/alerts'],
      ['admin', '/registry'],
      ['supervisor', '/sizing'],
    ];
    for (const [role, path] of allowed) {
      const res = middleware(request(path, signedIn(role)));
      expect(res.headers.get('location'), `${role} → ${path}`).toBeNull();
    }
  });
});

describe('a tampered role cookie', () => {
  it('is treated as unknown and redirected, not crashed on', () => {
    // The role cookie is readable by design, so it is user-editable by definition. It must be
    // handled as untrusted input — and everything it implies is re-checked by the API anyway.
    const res = middleware(request('/audit', { saakshi_session: 'a.b.c', saakshi_role: 'wizard' }));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/forbidden');
  });

  it('an escalated role gets the page but the API still decides the data', () => {
    // Editing the cookie to `admin` buys a menu item, not access: the request the page makes still
    // carries the original signed token, and the API refuses it.
    const res = middleware(request('/audit', { saakshi_session: 'a.b.c', saakshi_role: 'admin' }));
    expect(res.headers.get('location')).toBeNull();
  });

  it('a missing role cookie with a session redirects rather than assuming a role', () => {
    const res = middleware(request('/alerts', { saakshi_session: 'a.b.c' }));
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/forbidden');
  });
});
