/**
 * Shared tab strip renderer for tabbed dialogs (model selector, plugin
 * marketplace, …). The active tab is filled with the brand background, inactive
 * tabs are muted — matching the AskUserQuestion dialog. See
 * .agents/skills/write-tui/DESIGN.md §5.
 *
 * When the strip is wider than the terminal, it scrolls to keep the active tab
 * visible, framed by `<`/`>` markers.
 */

import { visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

export interface RenderTabStripOptions {
  readonly labels: readonly string[];
  readonly activeIndex: number;
  readonly width: number;
  readonly colors: ColorPalette;
}

/** Where one tab sits in the rendered strip, in columns. */
export interface TabStripSpan {
  /** First column of the tab's cell (inclusive). */
  readonly start: number;
  /** Column just past the tab's cell (exclusive). */
  readonly end: number;
  /** Index of the tab in `labels`. */
  readonly index: number;
}

export interface TabStripLayout {
  readonly text: string;
  readonly spans: readonly TabStripSpan[];
}

/** Style one tab cell. Active and inactive cells have the same visible width so
 * switching never shifts the layout. */
function styleTab(label: string, isActive: boolean, colors: ColorPalette): string {
  const cell = ` ${label} `;
  return isActive
    ? chalk.bgHex(colors.primary).hex(colors.text).bold(cell)
    : chalk.hex(colors.textMuted)(cell);
}

/**
 * The strip and the columns each tab occupies. A tabbed dialog records the
 * spans as click targets so the pointer can switch tabs.
 */
export function layoutTabStrip(opts: RenderTabStripOptions): TabStripLayout {
  const { labels, activeIndex, width, colors } = opts;
  const segments = labels.map((label, i) => styleTab(label, i === activeIndex, colors));

  // If everything fits with a leading space, show the whole strip. Account for
  // the single spaces `segments.join(' ')` inserts between tabs — otherwise the
  // strip is declared to fit at widths where the joined line is actually wider
  // and gets truncated instead of showing the `<`/`>` scroll markers.
  const totalSegmentWidth = segments.reduce((sum, s) => sum + visibleWidth(s), 0);
  const fullSeparatorWidth = Math.max(0, segments.length - 1);
  if (1 + totalSegmentWidth + fullSeparatorWidth <= width) {
    const spans: TabStripSpan[] = [];
    let column = 1;
    for (let i = 0; i < segments.length; i++) {
      const segmentWidth = visibleWidth(segments[i]!);
      spans.push({ start: column, end: column + segmentWidth, index: i });
      column += segmentWidth + 1;
    }
    return { text: ' ' + segments.join(' '), spans };
  }

  // Scrolling needed. Find the widest window that contains activeIndex.
  const segmentWidths = segments.map((s) => visibleWidth(s));
  let start = activeIndex;
  let end = activeIndex + 1;
  let contentWidth = segmentWidths[activeIndex] ?? 0;

  const fits = (s: number, e: number, cw: number): boolean => {
    const needLeft = s > 0;
    const needRight = e < segments.length;
    const frameWidth = (needLeft ? 2 : 1) + (needRight ? 2 : 0);
    const separators = Math.max(0, e - s - 1);
    return cw + separators + frameWidth <= width;
  };

  while (true) {
    const leftW = start > 0 ? segmentWidths[start - 1]! : Infinity;
    const rightW = end < segments.length ? segmentWidths[end]! : Infinity;
    if (leftW === Infinity && rightW === Infinity) break;

    if (leftW <= rightW) {
      if (fits(start - 1, end, contentWidth + leftW)) {
        contentWidth += leftW;
        start--;
      } else if (fits(start, end + 1, contentWidth + rightW)) {
        contentWidth += rightW;
        end++;
      } else {
        break;
      }
    } else if (fits(start, end + 1, contentWidth + rightW)) {
      contentWidth += rightW;
      end++;
    } else if (fits(start - 1, end, contentWidth + leftW)) {
      contentWidth += leftW;
      start--;
    } else {
      break;
    }
  }

  const hasLeft = start > 0;
  const hasRight = end < segments.length;
  let strip = hasLeft ? chalk.hex(colors.textMuted)('< ') : ' ';
  const spans: TabStripSpan[] = [];
  let column = hasLeft ? 2 : 1;
  for (let i = start; i < end; i++) {
    const segment = segments[i]!;
    const segmentWidth = visibleWidth(segment);
    spans.push({ start: column, end: column + segmentWidth, index: i });
    column += segmentWidth + 1;
    strip += (i === start ? '' : ' ') + segment;
  }
  if (hasRight) {
    strip += chalk.hex(colors.textMuted)(' >');
  }
  return { text: strip, spans };
}

export function renderTabStrip(opts: RenderTabStripOptions): string {
  return layoutTabStrip(opts).text;
}
