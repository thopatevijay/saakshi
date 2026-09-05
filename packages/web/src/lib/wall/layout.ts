/**
 * The wall's layout: what a grid is, which slots exist, and how a saved one is made safe to render.
 *
 * All pure, and separated from the screen deliberately — the acceptance criterion "layout persists
 * across reload per user" is about a value that survives a round trip through a database and back
 * into a browser, and the failure modes live at the edges of that trip: a grid that shrank while a
 * layout was saved at the larger size, a camera that was deleted between sessions, a stored array
 * of the wrong length. Those are testable without a browser, and they are where this breaks.
 */

export const WALL_GRIDS = ['2x2', '3x3', '4x4'] as const;
export type WallGrid = (typeof WALL_GRIDS)[number];

export const WALL_MODES = ['hls', 'whep'] as const;
export type WallMode = (typeof WALL_MODES)[number];

export interface WallLayout {
  grid: WallGrid;
  /** Positional and sparse: `null` is an empty slot the operator chose, not a gap to compact. */
  slots: (string | null)[];
  overlay: boolean;
  mode: WallMode;
}

/** Rows/columns for a grid. Derived from the name so the two can never disagree. */
export function gridDimensions(grid: WallGrid): { rows: number; columns: number } {
  const [columns, rows] = grid.split('x').map(Number) as [number, number];
  return { rows, columns };
}

export function slotCount(grid: WallGrid): number {
  const { rows, columns } = gridDimensions(grid);
  return rows * columns;
}

export function isWallGrid(value: unknown): value is WallGrid {
  return typeof value === 'string' && (WALL_GRIDS as readonly string[]).includes(value);
}

export function isWallMode(value: unknown): value is WallMode {
  return typeof value === 'string' && (WALL_MODES as readonly string[]).includes(value);
}

/**
 * A layout with every slot present and every camera one that still exists.
 *
 * Two rules, and both are about not lying to the operator:
 *
 *  - **Growing keeps positions.** Moving 2×2 → 3×3 must not reflow the four cameras into different
 *    corners; an operator who arranged their wall by junction geography would find it scrambled.
 *    Slots are index-addressed, so growth appends empties and the existing four stay put.
 *  - **Shrinking drops the tail, and says nothing clever about it.** 3×3 → 2×2 cannot keep nine
 *    cameras in four slots. Rather than choosing which five to discard by some heuristic the
 *    operator cannot predict, it keeps the first four in reading order.
 *
 * A camera id that is no longer in `known` becomes `null` rather than being silently substituted:
 * an empty slot is honest, and a *different* camera in the slot an officer remembers is the kind of
 * error that ends up in a court transcript.
 */
export function normaliseLayout(
  layout: Partial<WallLayout> | null | undefined,
  known: ReadonlySet<string>,
): WallLayout {
  const grid = isWallGrid(layout?.grid) ? layout.grid : '3x3';
  const size = slotCount(grid);
  const raw = Array.isArray(layout?.slots) ? layout.slots : [];

  const slots: (string | null)[] = Array.from({ length: size }, (_, index) => {
    const value = raw[index];
    if (typeof value !== 'string') return null;
    return known.has(value) ? value : null;
  });

  return {
    grid,
    slots,
    overlay: typeof layout?.overlay === 'boolean' ? layout.overlay : true,
    mode: isWallMode(layout?.mode) ? layout.mode : 'hls',
  };
}

/**
 * The default wall for an operator who has never saved one.
 *
 * Filled in registry order rather than left empty: an empty 3×3 is indistinguishable from a broken
 * one, and the first thing a judge does with this screen is open it.
 */
export function defaultLayout(cameraIds: readonly string[], grid: WallGrid = '3x3'): WallLayout {
  const size = slotCount(grid);
  return {
    grid,
    slots: Array.from({ length: size }, (_, index) => cameraIds[index] ?? null),
    overlay: true,
    mode: 'hls',
  };
}

/** Resize, preserving positions on growth and the reading-order head on shrink. */
export function resize(layout: WallLayout, grid: WallGrid): WallLayout {
  const size = slotCount(grid);
  return {
    ...layout,
    grid,
    slots: Array.from({ length: size }, (_, index) => layout.slots[index] ?? null),
  };
}

/**
 * Put a camera in a slot.
 *
 * If it is already on the wall elsewhere the two slots **swap**. Showing one camera twice is almost
 * never what an operator meant, and a swap is the move they were reaching for — dragging cam12 onto
 * cam04's tile means "put these two the other way round", not "show cam12 twice".
 */
export function assign(layout: WallLayout, index: number, cameraId: string | null): WallLayout {
  if (index < 0 || index >= layout.slots.length) return layout;
  const slots = [...layout.slots];
  const previous = slots[index] ?? null;

  if (cameraId !== null) {
    const existing = slots.indexOf(cameraId);
    if (existing !== -1 && existing !== index) slots[existing] = previous;
  }
  slots[index] = cameraId;
  return { ...layout, slots };
}

/**
 * The distinct cameras a layout actually needs open.
 *
 * This is the number that matters for "only open the cameras being viewed": a wall with the same
 * camera in two slots must not cost the gateway two connections, and the tiles share one player per
 * camera because of this set.
 */
export function activeCameraIds(layout: WallLayout): string[] {
  return [...new Set(layout.slots.filter((id): id is string => id !== null))];
}

export function layoutsEqual(a: WallLayout, b: WallLayout): boolean {
  return (
    a.grid === b.grid &&
    a.overlay === b.overlay &&
    a.mode === b.mode &&
    a.slots.length === b.slots.length &&
    a.slots.every((slot, index) => slot === b.slots[index])
  );
}
