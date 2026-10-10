import { describe, expect, it } from 'vitest';

import {
  computeBudget,
  STATUS_SURFACE_MAX_ROWS,
  STATUS_SURFACE_MIN_REGION_ROWS,
  surfaceTotalRows,
} from '#/tui/components/chrome/status-surface/budget';
import {
  REGION_PRIORITY,
  sortRegions,
  type RegionId,
  type RegionRenderContext,
  type StatusRegion,
} from '#/tui/components/chrome/status-surface/region';

function fakeRegion(id: RegionId, want: number, empty = false): StatusRegion {
  return {
    id,
    isEmpty: () => empty,
    measure: () => want,
    render: (_ctx: RegionRenderContext) => [],
    isExpanded: () => true,
    setExpanded: () => {},
    hasHiddenContent: () => false,
  };
}

describe('surfaceTotalRows', () => {
  it('never exceeds the ceiling or half the terminal, whichever is smaller', () => {
    for (let rows = 4; rows <= 200; rows += 1) {
      const total = surfaceTotalRows(rows);
      expect(total).toBeLessThanOrEqual(STATUS_SURFACE_MAX_ROWS);
      expect(total).toBeLessThanOrEqual(Math.max(1, Math.floor(rows / 2)));
    }
  });

  it('is monotonically non-decreasing as the terminal grows', () => {
    let previous = 0;
    for (let rows = 1; rows <= 120; rows += 1) {
      const total = surfaceTotalRows(rows);
      expect(total).toBeGreaterThanOrEqual(previous);
      previous = total;
    }
  });

  it('falls back to the ceiling for an unavailable or nonsensical row count', () => {
    expect(surfaceTotalRows(0)).toBe(STATUS_SURFACE_MAX_ROWS);
    expect(surfaceTotalRows(-5)).toBe(STATUS_SURFACE_MAX_ROWS);
    expect(surfaceTotalRows(Number.NaN)).toBe(STATUS_SURFACE_MAX_ROWS);
    expect(surfaceTotalRows(Number.POSITIVE_INFINITY)).toBe(STATUS_SURFACE_MAX_ROWS);
  });

  it('never returns zero, so a one-row terminal still shows something', () => {
    for (const rows of [0, 1, 2, 3, 4]) {
      expect(surfaceTotalRows(rows)).toBeGreaterThanOrEqual(STATUS_SURFACE_MIN_REGION_ROWS);
    }
  });
});

describe('sortRegions', () => {
  it('orders blocking regions ahead of informational ones', () => {
    const ordered = sortRegions([
      fakeRegion('updates', 1),
      fakeRegion('todo', 1),
      fakeRegion('approval', 1),
    ]);
    expect(ordered.map((region) => region.id)).toEqual(['approval', 'todo', 'updates']);
  });

  it('mirrors the exported priority table', () => {
    expect(REGION_PRIORITY.approval).toBeLessThan(REGION_PRIORITY.todo);
    expect(REGION_PRIORITY.todo).toBeLessThan(REGION_PRIORITY.updates);
  });
});

describe('computeBudget', () => {
  it('returns zero chrome and an empty map when nothing is present', () => {
    const budget = computeBudget(24, [], 80);
    expect(budget.perRegion.size).toBe(0);
    // Half of 24 rows is the smaller of the two caps.
    expect(budget.total).toBe(12);
  });

  it('reports the ceiling when the terminal height is unknown', () => {
    const budget = computeBudget(Number.NaN, [], 80);
    expect(budget.total).toBe(STATUS_SURFACE_MAX_ROWS);
  });

  it('skips empty regions entirely', () => {
    const budget = computeBudget(40, [fakeRegion('todo', 5), fakeRegion('updates', 5, true)], 80);
    expect([...budget.perRegion.keys()]).toEqual(['todo']);
  });

  it('never allocates more rows than the total', () => {
    for (let rows = 4; rows <= 80; rows += 1) {
      const budget = computeBudget(
        rows,
        [fakeRegion('approval', 30), fakeRegion('todo', 30), fakeRegion('updates', 30)],
        80,
      );
      const granted = [...budget.perRegion.values()].reduce((sum, value) => sum + value, 0);
      expect(granted).toBeLessThanOrEqual(budget.total);
    }
  });

  it('serves the blocking region first and leaves the rest to share what remains', () => {
    // 40 rows -> total 20 rows to divide.
    const budget = computeBudget(
      40,
      [fakeRegion('approval', 10), fakeRegion('todo', 20), fakeRegion('updates', 20)],
      80,
    );
    expect(budget.perRegion.get('approval')).toBe(10);
    expect(budget.perRegion.get('todo')).toBe(10);
    expect(budget.perRegion.get('updates')).toBe(0);
  });

  it('clamps a greedy region to what is left instead of overflowing', () => {
    const budget = computeBudget(24, [fakeRegion('approval', 100), fakeRegion('todo', 100)], 80);
    // total 12 rows for two regions.
    expect(budget.perRegion.get('approval')).toBe(12);
    expect(budget.perRegion.get('todo')).toBe(0);
  });

  it('gives every present region at least one row while room remains', () => {
    const budget = computeBudget(24, [fakeRegion('todo', 5), fakeRegion('updates', 5)], 80);
    expect(budget.perRegion.get('todo')).toBeGreaterThanOrEqual(1);
    expect(budget.perRegion.get('updates')).toBeGreaterThanOrEqual(1);
  });

  it('still reports the region it had to starve, so the surface can skip it', () => {
    const budget = computeBudget(8, [fakeRegion('approval', 100), fakeRegion('todo', 100)], 80);
    expect(budget.perRegion.has('todo')).toBe(true);
    expect(budget.perRegion.get('todo')).toBe(0);
  });

  it('treats a region that wants no rows as owing nothing', () => {
    const budget = computeBudget(40, [fakeRegion('todo', 0), fakeRegion('updates', 4)], 80);
    expect(budget.perRegion.get('todo')).toBe(STATUS_SURFACE_MIN_REGION_ROWS);
    expect(budget.perRegion.get('updates')).toBe(4);
  });
});
