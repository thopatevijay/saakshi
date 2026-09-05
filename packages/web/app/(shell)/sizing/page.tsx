/**
 * `/sizing` — the infrastructure sizing and cost calculator (D3-08).
 *
 * A server component that renders one client island. There is deliberately nothing to fetch: the
 * whole model is pure arithmetic over constants that ship in `@saakshi/shared`, so the screen works
 * with the API down, works offline, and recomputes inside the keystroke that changed an input.
 *
 * Access is governed by `sizing:use` in the shared capability matrix, checked by middleware and by
 * the shell layout before this renders.
 */
import { Calculator } from './calculator';

/**
 * Dynamic, even though this page fetches nothing.
 *
 * `force-static` looks right here — the calculator is a client island over constants that ship in
 * the bundle — but it renders the route without a request, so the shell layout's `cookies()` sees no
 * session and redirects every visitor to `/login`. The page has no data to cache; the layout around
 * it has a user to identify.
 */
export const dynamic = 'force-dynamic';

export default function Page() {
  return <Calculator />;
}
