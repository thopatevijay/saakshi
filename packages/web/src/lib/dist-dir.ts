/**
 * Where Next writes its build output — and why dev and production must never share it.
 *
 * ## The bug this exists to prevent (D3-13)
 *
 * `npm start` runs `next dev`, which serves compiled assets out of its output directory. A
 * production build writes a *clean* output into the same place, deleting the running dev server's
 * chunk graph. The dev server does not notice: it keeps serving HTML that references its own,
 * now-deleted chunk URLs, and every one of them 404s.
 *
 * The failure is silent in the worst possible way. `next/dynamic` swallows the rejected chunk
 * import, so a lazily-loaded component sits on its `loading` placeholder forever with **no error in
 * the console, no failed fetch the page reports, and no server-side complaint**. The server-rendered
 * HTML still paints the shell around it, so it reads as "one panel is broken" rather than "the
 * client bundle is dead" — hydration never ran at all.
 *
 * That is exactly how the GIS map — Model 1's compulsory deliverable — was blank for a day. It cost
 * a full ticket of investigation aimed at the dependency tree, a CSP and MapLibre's blob worker,
 * because two things hid the real cause:
 *
 *   - **`npm ci` cannot fix it.** The damage is in the build output, not in `node_modules`.
 *   - **Restarting the dev server cannot fix it either.** `next dev` reuses the poisoned directory;
 *     only deleting it recovers. So whichever server compiled last worked and the other was broken,
 *     which made the fault look like it reproduced in dev *and* production at once.
 *
 * The trap is laid by the project's own instructions: the D3-13 validation gate and
 * `docs/basemap-setup.md` both say to run `npm run build -w @saakshi/web`, and `npm start` leaves a
 * dev server running while you do it.
 *
 * ## The fix
 *
 * Two directories, chosen by the mode Next is already running in. `next dev` gets `.next`;
 * `next build` and `next start` get `.next-prod`. Both production commands resolve the same value
 * from this one function, so a build and the server that serves it always agree, and neither can
 * reach the other's files.
 *
 * `NEXT_DIST_DIR` overrides both, for a deployment that needs to place the output somewhere
 * specific. Anything copying build output (a Dockerfile, a Railway deploy — D4-01) must copy
 * **`.next-prod`**, not `.next`.
 */

/** The dev server's directory. Written by `next dev`, and by nothing else. */
export const DEV_DIST_DIR = '.next';

/** The production directory. Written by `next build`, read by `next start`. */
export const PROD_DIST_DIR = '.next-prod';

/**
 * The output directory for the mode Next is running in.
 *
 * Next sets `NODE_ENV` itself before it loads the config — `development` for `next dev`,
 * `production` for `next build` and `next start` — so the mode is already decided by the time this
 * is called and does not need to be passed in separately.
 */
export function distDirFor(env: Readonly<Record<string, string | undefined>>): string {
  const override = env['NEXT_DIST_DIR'];
  if (override !== undefined && override !== '') return override;
  return env['NODE_ENV'] === 'development' ? DEV_DIST_DIR : PROD_DIST_DIR;
}
