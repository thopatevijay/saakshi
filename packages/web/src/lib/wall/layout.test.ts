import { describe, expect, it } from 'vitest';
import {
  activeCameraIds,
  assign,
  defaultLayout,
  gridDimensions,
  layoutsEqual,
  normaliseLayout,
  resize,
  slotCount,
  type WallLayout,
} from './layout';

const ids = Array.from({ length: 20 }, (_, i) => `cam-${String(i).padStart(2, '0')}`);
const known = new Set(ids);

describe('grid geometry', () => {
  it('derives rows and columns from the grid name', () => {
    expect(gridDimensions('2x2')).toEqual({ rows: 2, columns: 2 });
    expect(gridDimensions('3x3')).toEqual({ rows: 3, columns: 3 });
    expect(gridDimensions('4x4')).toEqual({ rows: 4, columns: 4 });
  });

  it('counts slots from the same source', () => {
    expect([slotCount('2x2'), slotCount('3x3'), slotCount('4x4')]).toEqual([4, 9, 16]);
  });
});

describe('defaultLayout', () => {
  it('fills a 3x3 in registry order — an empty wall looks broken', () => {
    const layout = defaultLayout(ids);
    expect(layout.grid).toBe('3x3');
    expect(layout.slots).toHaveLength(9);
    expect(layout.slots.slice(0, 3)).toEqual(['cam-00', 'cam-01', 'cam-02']);
  });

  it('leaves the tail empty when the estate is smaller than the grid', () => {
    const layout = defaultLayout(['a', 'b'], '2x2');
    expect(layout.slots).toEqual(['a', 'b', null, null]);
  });
});

describe('normaliseLayout', () => {
  it('pads a stored layout that is short of the grid', () => {
    const layout = normaliseLayout({ grid: '3x3', slots: ['cam-00'] }, known);
    expect(layout.slots).toHaveLength(9);
    expect(layout.slots[0]).toBe('cam-00');
    expect(layout.slots[8]).toBeNull();
  });

  it('truncates a stored layout that is longer than the grid', () => {
    const layout = normaliseLayout({ grid: '2x2', slots: ids.slice(0, 9) }, known);
    expect(layout.slots).toEqual(['cam-00', 'cam-01', 'cam-02', 'cam-03']);
  });

  it('empties a slot whose camera no longer exists rather than substituting one', () => {
    const layout = normaliseLayout({ grid: '2x2', slots: ['cam-00', 'deleted', null, 'cam-03'] }, known);
    expect(layout.slots).toEqual(['cam-00', null, null, 'cam-03']);
  });

  it('falls back to a sane wall when the stored value is junk', () => {
    expect(normaliseLayout({ grid: '9x9' as never, slots: 'nope' as never }, known)).toEqual({
      grid: '3x3',
      slots: Array.from({ length: 9 }, () => null),
      overlay: true,
      mode: 'hls',
    });
    expect(normaliseLayout(null, known).grid).toBe('3x3');
  });

  it('keeps overlay and mode when they are valid, defaults them when they are not', () => {
    expect(normaliseLayout({ grid: '2x2', slots: [], overlay: false, mode: 'whep' }, known)).toMatchObject({
      overlay: false,
      mode: 'whep',
    });
    expect(normaliseLayout({ grid: '2x2', slots: [], mode: 'rtsp' as never }, known).mode).toBe('hls');
  });
});

describe('resize', () => {
  const base: WallLayout = {
    grid: '2x2',
    slots: ['a', 'b', 'c', 'd'],
    overlay: true,
    mode: 'hls',
  };

  it('keeps every camera in the slot it was in when the grid grows', () => {
    const grown = resize(base, '3x3');
    expect(grown.slots.slice(0, 4)).toEqual(['a', 'b', 'c', 'd']);
    expect(grown.slots).toHaveLength(9);
  });

  it('keeps the reading-order head when the grid shrinks', () => {
    const nine: WallLayout = { ...base, grid: '3x3', slots: ids.slice(0, 9) };
    expect(resize(nine, '2x2').slots).toEqual(ids.slice(0, 4));
  });

  it('round-trips 2x2 -> 4x4 -> 2x2 without moving anything', () => {
    expect(resize(resize(base, '4x4'), '2x2').slots).toEqual(base.slots);
  });
});

describe('assign', () => {
  const base: WallLayout = { grid: '2x2', slots: ['a', 'b', 'c', 'd'], overlay: true, mode: 'hls' };

  it('places a camera that is not already on the wall', () => {
    expect(assign(base, 1, 'z').slots).toEqual(['a', 'z', 'c', 'd']);
  });

  it('swaps rather than duplicating when the camera is already on the wall', () => {
    expect(assign(base, 0, 'd').slots).toEqual(['d', 'b', 'c', 'a']);
  });

  it('clears a slot', () => {
    expect(assign(base, 2, null).slots).toEqual(['a', 'b', null, 'd']);
  });

  it('ignores an out-of-range slot instead of growing the array', () => {
    expect(assign(base, 9, 'z')).toBe(base);
    expect(assign(base, -1, 'z')).toBe(base);
  });
});

describe('activeCameraIds', () => {
  it('is the set of cameras a wall must actually open — duplicates cost one connection, not two', () => {
    const layout: WallLayout = {
      grid: '2x2',
      slots: ['a', 'b', 'a', null],
      overlay: true,
      mode: 'hls',
    };
    expect(activeCameraIds(layout)).toEqual(['a', 'b']);
  });
});

describe('layoutsEqual', () => {
  const base: WallLayout = { grid: '2x2', slots: ['a', null, 'c', 'd'], overlay: true, mode: 'hls' };

  it('is true for the same wall and false for any single change', () => {
    expect(layoutsEqual(base, { ...base, slots: [...base.slots] })).toBe(true);
    expect(layoutsEqual(base, { ...base, overlay: false })).toBe(false);
    expect(layoutsEqual(base, { ...base, mode: 'whep' })).toBe(false);
    expect(layoutsEqual(base, assign(base, 1, 'b'))).toBe(false);
    expect(layoutsEqual(base, resize(base, '3x3'))).toBe(false);
  });
});
