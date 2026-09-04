/**
 * "Every route has explicit loading, empty, and error states."
 *
 * Enumerated from the filesystem rather than listed by hand, so a screen added in a later ticket
 * cannot quietly ship without them — the test fails the moment a route directory appears without
 * its states, which is the only way this criterion stays true after today.
 */
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = path.resolve(import.meta.dirname, '../../app');
const SHELL_DIR = path.join(APP_DIR, '(shell)');

function routeDirs(parent: string): string[] {
  return readdirSync(parent, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith('(') && !entry.name.startsWith('_'),
    )
    .map((entry) => path.join(parent, entry.name));
}

describe('every shell route ships its states', () => {
  const routes = routeDirs(SHELL_DIR);

  it('there are routes to check', () => {
    expect(routes.length).toBeGreaterThanOrEqual(6);
  });

  it.each(routes.map((dir) => [path.basename(dir), dir]))('%s has a page', (_name, dir) => {
    expect(existsSync(path.join(dir, 'page.tsx'))).toBe(true);
  });

  it.each(routes.map((dir) => [path.basename(dir), dir]))('%s has loading.tsx', (_name, dir) => {
    expect(existsSync(path.join(dir, 'loading.tsx'))).toBe(true);
  });

  it.each(routes.map((dir) => [path.basename(dir), dir]))('%s has error.tsx', (_name, dir) => {
    expect(existsSync(path.join(dir, 'error.tsx'))).toBe(true);
  });
});

describe('the login route and the app root ship theirs too', () => {
  it('login has loading and error', () => {
    const login = path.join(APP_DIR, 'login');
    expect(existsSync(path.join(login, 'loading.tsx'))).toBe(true);
    expect(existsSync(path.join(login, 'error.tsx'))).toBe(true);
  });

  it('the root has a global error, loading and not-found', () => {
    for (const file of ['error.tsx', 'loading.tsx', 'not-found.tsx']) {
      expect(existsSync(path.join(APP_DIR, file)), file).toBe(true);
    }
  });
});

describe('the empty state is a shared component, not per-screen improvisation', () => {
  it('exists and is exported alongside the loading and error states', async () => {
    const states = await import('@/src/components/states');
    expect(typeof states.EmptyState).toBe('function');
    expect(typeof states.ErrorState).toBe('function');
    expect(typeof states.LoadingPanel).toBe('function');
    expect(typeof states.Spinner).toBe('function');
  });
});
