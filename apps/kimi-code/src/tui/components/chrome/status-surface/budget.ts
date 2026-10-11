/**
 * The single height budget for the status surface.
 *
 * Before this module every panel computed its own ceiling from
 * `terminal.rows` and they had to agree by hand: the todo panel capped itself
 * at 16 rows, the Updates box at 12, and the dock that holds them declared a
 * static 18 with a comment asking future editors to keep the three numbers "in
 * step". Nothing enforced it, and a panel cannot in principle know what its
 * siblings already took.
 *
 * The surface now owns one budget. Regions report what they want; this module
 * divides it by priority and hands each region a number it must respect.
 */

import { sortRegions, type RegionId, type StatusRegion } from './region';

/**
 * Hard ceiling on the whole surface, chrome included. This is also the value
 * the dock uses as its `maxSize`, so the two layers cannot drift apart.
 */
export const STATUS_SURFACE_MAX_ROWS = 20;

/** Body rows granted to a region that is present but has almost no room. */
export const STATUS_SURFACE_MIN_REGION_ROWS = 1;

export interface SurfaceBudget {
  /** Total rows the surface may occupy. */
  readonly total: number;
  /** Rows granted per region id; regions absent from the list are omitted. */
  readonly perRegion: ReadonlyMap<RegionId, number>;
}

/**
 * Rows the surface may draw.
 *
 * `rows / 2` is the readability rule the panels used to apply individually: a
 * status strip must never own more than half the screen, or the transcript and
 * editor lose the space that is the point of the session. An unknown or
 * nonsensical terminal height falls back to the ceiling rather than to zero —
 * losing the cap because a row count was momentarily unavailable is exactly
 * the bug the per-panel versions had.
 */
export function surfaceTotalRows(rows: number): number {
  if (!Number.isFinite(rows) || rows <= 0) return STATUS_SURFACE_MAX_ROWS;
  return Math.max(STATUS_SURFACE_MIN_REGION_ROWS, Math.min(STATUS_SURFACE_MAX_ROWS, Math.floor(rows / 2)));
}

/**
 * Divide `rows` across `regions`, after the surface's own rows.
 *
 * Highest priority is served first with `min(want, remaining)`, so a blocking
 * approval always gets the rows it asked for and the informational regions
 * share what is left. A region that would receive zero rows is still given
 * `STATUS_SURFACE_MIN_REGION_ROWS` while any room remains, so a region never
 * disappears silently; once the budget is exhausted the rest get `0` and the
 * surface skips them.
 *
 * `chromeRows` is what the surface spends before any region draws — its frame
 * and the rules between stacked regions. It comes out of the same pool rather
 * than being added on top, so a grant can never push the surface past the
 * ceiling it declared to the terminal.
 *
 * The sum of `perRegion` is always `<= total - chromeRows`: the surface can
 * never ask the terminal for more rows than it declared.
 */
export function computeBudget(
  rows: number,
  regions: readonly StatusRegion[],
  width: number,
  chromeRows = 0,
): SurfaceBudget {
  const total = surfaceTotalRows(rows);
  const ordered = sortRegions(regions.filter((region) => !region.isEmpty()));
  let remaining = Math.max(0, total - Math.max(0, chromeRows));

  const perRegion = new Map<RegionId, number>();
  for (const region of ordered) {
    if (remaining <= 0) {
      perRegion.set(region.id, 0);
      continue;
    }
    const want = Math.max(0, region.measure(width));
    const granted = Math.max(STATUS_SURFACE_MIN_REGION_ROWS, Math.min(want, remaining));
    perRegion.set(region.id, granted);
    remaining -= granted;
  }

  return { total, perRegion };
}

/** True when the surface has nothing to draw and must occupy no rows. */
export function isSurfaceEmpty(regions: readonly StatusRegion[]): boolean {
  return regions.every((region) => region.isEmpty());
}
