/**
 * StatsRegion — the session's running totals in the status surface: turns and
 * steps, LLM and tool time, first-token latency, token usage, and the context
 * readout.
 *
 * This is the only place those totals are rendered. The footer carried them on
 * its second line as well, which put the same five readings on screen twice,
 * one directly above the other; the strip is the copy that survives a long
 * session, so the footer's went away.
 *
 * It is read-only and never claims focus: there is nothing to page through, and
 * a click on it should keep typing where it was.
 */

import { visibleWidth } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import type { SessionStatsGroup } from '#/tui/utils/session-stats';

import type {
  RegionId,
  RegionKey,
  RegionPlacement,
  RegionRenderContext,
  StatusRegion,
} from '../region';

/** Cells between two laid-out columns of the readout. */
const STATS_COLUMN_GAP = 3;

export class StatsRegion implements StatusRegion {
  readonly id: RegionId = 'stats';
  readonly priority = 30;
  readonly blocking = false;
  readonly minRows = 2;

  private expanded = true;
  private segmentsProvider: () => SessionStatsGroup[] = () => [];
  private hasSibling: (() => boolean) | undefined;
  /**
   * Width of the last paint. `hasHiddenContent` is asked between frames, when
   * no render context exists, so it measures against the width the region was
   * last laid out at.
   */
  private lastWidth = 80;

  constructor(segments?: () => SessionStatsGroup[]) {
    if (segments !== undefined) this.segmentsProvider = segments;
  }

  /** Installed by the host once the state object it closes over exists. */
  setSegmentsProvider(provider: () => SessionStatsGroup[]): void {
    this.segmentsProvider = provider;
  }

  private segments(): SessionStatsGroup[] {
    return this.segmentsProvider();
  }

  /**
   * Left column beside the updates box, and the whole band when there is no
   * updates box to share with — a lone left column would leave the right half
   * of the band empty and squeeze a ~100-character readout into 38 columns.
   */
  placement(): RegionPlacement {
    return this.hasSibling?.() === true ? 'left' : 'full';
  }

  /** Told by the host what else is in the band, so widening stays accurate. */
  setSiblingProbe(probe: () => boolean): void {
    this.hasSibling = probe;
  }

  isEmpty(): boolean {
    return this.segments().length === 0;
  }

  /**
   * The readings, each with the priority that says how badly it wants a row.
   * One entry per group; the group's own items stay joined because they are
   * read together.
   */
  private readings(): { text: string; priority: number }[] {
    return this.segments()
      .map((group) => ({
        text: group.items.map((item) => item.text).join(' · '),
        priority: Math.min(...group.items.map((item) => item.priority), Number.POSITIVE_INFINITY),
      }))
      .filter((reading) => reading.text.length > 0);
  }

  /**
   * Rows this region would like, laid out as a table that fits `width`.
   *
   * The column count comes from the room available, not from a mode: the widest
   * reading decides the cell, and as many cells as fit side by side share a row.
   * A wide band therefore reads in two or three rows instead of one long line
   * that leaves the width half used, and a narrow column — where only one cell
   * fits — reads one reading per row, which fills the height the neighbouring
   * updates box sets. Nothing is dropped; a reading too wide for its cell wraps.
   *
   * `minRows` bounds only the folded form.
   */
  private rowsAt(width: number, readings = this.readings()): string[] {
    const limit = Math.max(1, width);
    if (readings.length === 0) return [];
    const cell = Math.max(...readings.map((reading) => visibleWidth(reading.text)));
    const columns = Math.max(
      1,
      Math.min(readings.length, Math.floor((limit + STATS_COLUMN_GAP) / (cell + STATS_COLUMN_GAP))),
    );
    if (columns === 1) return readings.flatMap((reading) => breakRow(reading.text, limit));

    const rows: string[] = [];
    for (let start = 0; start < readings.length; start += columns) {
      const row = readings
        .slice(start, start + columns)
        .map((reading) => {
          const pad = Math.max(0, cell - visibleWidth(reading.text));
          return reading.text + ' '.repeat(pad);
        })
        .join(' '.repeat(STATS_COLUMN_GAP));
      rows.push(row.trimEnd());
    }
    return rows;
  }

  measure(width: number): number {
    return this.rowsAt(width).length;
  }

  /**
   * The rows to paint, cut to the granted budget.
   *
   * The budget can be smaller than the table needs, and which reading goes has
   * to follow `priority`, not the display order: the context readout is the last
   * cell on screen and the one reading a later render cannot reconstruct, so
   * slicing the tail would drop exactly the wrong line. Readings are dropped
   * lowest-priority-first until the rest fits, and the survivors keep their
   * order — and with them the column count, so the table stays aligned.
   */
  private rowsWithin(width: number, budget: number): string[] {
    let readings = this.readings();
    while (readings.length > 0) {
      const rows = this.rowsAt(width, readings);
      if (rows.length <= budget) return rows;
      const droppable = readings
        .map((reading, index) => ({ reading, index }))
        .filter((entry) => Number.isFinite(entry.reading.priority))
        .toSorted((a, b) => a.reading.priority - b.reading.priority)[0];
      if (droppable === undefined) return rows.slice(0, budget);
      readings = readings.filter((_, index) => index !== droppable.index);
    }
    return [];
  }

  render(ctx: RegionRenderContext): string[] {
    this.lastWidth = ctx.width;
    const rows = this.rowsWithin(ctx.width, ctx.budget);
    if (rows.length === 0) return [];
    if (!this.expanded && rows.length > this.minRows) {
      const visible = rows.slice(0, this.minRows - 1);
      visible.push(
        t('tui.chrome.statusSurface.statsMore', { count: String(rows.length - this.minRows + 1) }),
      );
      return visible.slice(0, ctx.budget);
    }
    return rows.slice(0, ctx.budget);
  }
  isExpanded(): boolean {
    return this.expanded;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  hasHiddenContent(): boolean {
    return this.rowsAt(this.lastWidth).length > this.minRows;
  }

  handleKey(_key: RegionKey): boolean {
    return false;
  }
}

/**
 * Break one row into pieces no wider than `limit`, preferring the spaces
 * between words and falling back to cutting a single over-long word.
 *
 * The fallback matters for localised text: `首 token 平均 1.8s | 缓存命中 74%`
 * has spaces to break at, but a run like `上下文：13%（120k/977k）` does not, and
 * a row with no break point must still lose nothing rather than be clipped by
 * the frame.
 */
function breakRow(row: string, limit: number): string[] {
  if (visibleWidth(row) <= limit) return [row];
  const out: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) out.push(current);
    current = '';
  };
  for (const word of row.split(' ')) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= limit) {
      current = candidate;
      continue;
    }
    flush();
    let rest = word;
    while (visibleWidth(rest) > limit) {
      let take = '';
      for (const character of rest) {
        if (visibleWidth(take + character) > limit) break;
        take += character;
      }
      if (take.length === 0) take = rest.slice(0, 1);
      out.push(take);
      rest = rest.slice(take.length);
    }
    current = rest;
  }
  flush();
  return out;
}
