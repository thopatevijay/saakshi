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

export const dynamic = 'force-static';

export default function Page() {
  return <Calculator />;
}
