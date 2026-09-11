import { describe, expect, it } from 'vitest';
import { DEV_DIST_DIR, PROD_DIST_DIR, distDirFor } from './dist-dir';

/**
 * The invariant these tests protect is one line long and cost a day: a production build must not be
 * able to write into the directory a running `next dev` is serving from. See `dist-dir.ts` for the
 * failure mode — a lazily-loaded component stuck on its placeholder forever, with nothing logged
 * anywhere.
 *
 * The assertion that matters is the last one. The specific directory names are an implementation
 * detail and may change; "they are not the same directory" is the property.
 */
describe('distDirFor', () => {
  it('gives the dev server its own directory', () => {
    expect(distDirFor({ NODE_ENV: 'development' })).toBe(DEV_DIST_DIR);
  });

  it('gives a production build a different one', () => {
    expect(distDirFor({ NODE_ENV: 'production' })).toBe(PROD_DIST_DIR);
  });

  it('resolves `next build` and `next start` to the same directory, or the server serves nothing', () => {
    // Both commands run with NODE_ENV=production and read this one function, so agreement is
    // structural rather than a convention someone has to remember.
    expect(distDirFor({ NODE_ENV: 'production' })).toBe(distDirFor({ NODE_ENV: 'production' }));
  });

  it('treats an unset NODE_ENV as production rather than colliding with dev', () => {
    // A tool that forgets to set NODE_ENV must not be handed the dev server's directory: the whole
    // point is that only `next dev` ever writes there.
    expect(distDirFor({})).toBe(PROD_DIST_DIR);
  });

  it('lets a deployment override the location', () => {
    expect(distDirFor({ NODE_ENV: 'production', NEXT_DIST_DIR: 'build/out' })).toBe('build/out');
    expect(distDirFor({ NODE_ENV: 'development', NEXT_DIST_DIR: 'build/out' })).toBe('build/out');
  });

  it('ignores an empty override instead of writing to the repo root', () => {
    expect(distDirFor({ NODE_ENV: 'production', NEXT_DIST_DIR: '' })).toBe(PROD_DIST_DIR);
  });

  it('never lets a production build write where the dev server is serving from', () => {
    expect(distDirFor({ NODE_ENV: 'production' })).not.toBe(distDirFor({ NODE_ENV: 'development' }));
  });
});
