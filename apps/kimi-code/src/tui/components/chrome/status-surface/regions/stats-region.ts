/**
 * StatsRegion — the session's running totals in the status surface's left
 * column: turns and steps, LLM and tool time, first-token latency, token
 * usage, and the context readout.
 *
 * The todo list used to own this column and renders as a transcript card now,
 * which left the left half of any band blank next to the updates box. The
 * numbers it holds are the same ones the footer's second line carries, built by
 * the same segment builder and dropped by the same priority rule, so the two
 * cannot disagree about what a session cost.
 *
 * It is read-only and never claims focus: there is nothing to page through, and
 * a click on it should keep typing where it was.
 */

import { t } from '#/i18n';
import type { SessionStatsGroup } from '#/tui/utils/session-stats';

import type {
  RegionId,
  RegionKey,
  RegionPlacement,
  RegionRenderContext,
  StatusRegion,
} from '../region';

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
   * Rows this region would like. Unlike the footer, which has one line and must
   * drop items to fit it, the strip can grow downward: the groups wrap instead
   * of being discarded, so a narrow left column loses no information — it takes
   * a second row. `minRows` therefore only bounds the folded form.
   */
  private rowsAt(width: number): string[] {
    return wrapSegments(this.segments(), width);
  }

  measure(width: number): number {
    return this.rowsAt(width).length;
  }

  render(ctx: RegionRenderContext): string[] {
    this.lastWidth = ctx.width;
    const rows = this.rowsAt(ctx.width);
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
 * Lay the stat groups out across as many rows as they need.
 *
 * Within a row, items are joined with ` · ` and groups with ` | ` — the same
 * separators the footer uses, so the two readouts look like one family. When a
 * group does not fit the remaining space it starts the next row instead of
 * being truncated or dropped.
 */
function wrapSegments(groups: readonly SessionStatsGroup[], width: number): string[] {
  const limit = Math.max(1, width);
  const rows: string[] = [];
  let current = '';
  for (const group of groups) {
    const text = group.items.map((item) => item.text).join(' · ');
    if (text.length === 0) continue;
    if (current.length === 0) {
      current = text;
      continue;
    }
    const joined = `${current} | ${text}`;
    if (joined.length <= limit) {
      current = joined;
      continue;
    }
    rows.push(current);
    current = text;
  }
  if (current.length > 0) rows.push(current);
  return hardWrap(rows, limit);
}

/** Split any row still wider than the column at word boundaries. */
function hardWrap(rows: readonly string[], limit: number): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.length <= limit) {
      out.push(row);
      continue;
    }
    let current = '';
    for (const word of row.split(' ')) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (candidate.length > limit && current.length > 0) {
        out.push(current);
        current = word;
        continue;
      }
      current = candidate;
    }
    if (current.length > 0) out.push(current);
  }
  return out;
}
