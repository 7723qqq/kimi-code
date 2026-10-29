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
import { fitSessionStatsText, type SessionStatsGroup } from '#/tui/utils/session-stats';

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

  measure(width: number): number {
    const text = fitSessionStatsText(this.segments(), width);
    return text.length === 0 ? 0 : wrapRows(text, width).length;
  }

  render(ctx: RegionRenderContext): string[] {
    const text = fitSessionStatsText(this.segments(), ctx.width);
    if (text.length === 0) return [];
    const rows = wrapRows(text, ctx.width);
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
    return this.expanded && this.segments().length > 0;
  }

  handleKey(_key: RegionKey): boolean {
    return false;
  }
}

/** Greedy word wrap over the already width-fitted stat text. */
function wrapRows(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const rows: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > limit && current.length > 0) {
      rows.push(current);
      current = word;
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) rows.push(current);
  return rows;
}
