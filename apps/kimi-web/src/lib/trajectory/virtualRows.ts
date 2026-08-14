// Virtual-row projection for the trajectory ledger: measurable fixed-height
// rows, request-only records attached to the next content row, stable row
// keys. Ported from deepseek-harness ui-trajectory trajectory-virtual-rows.ts
// (MIT).

import type { TrajectoryRecord } from './records';

export const TRAJECTORY_CONTENT_ROW_HEIGHT = 30;
export const TRAJECTORY_COLLAPSED_SUMMARY_HEIGHT = 20;
export const TRAJECTORY_TERMINAL_BOUNDARY_HEIGHT = 9;

export interface TrajectoryVirtualRowEntry {
  readonly logicalIndex: number;
  readonly record: TrajectoryRecord;
  readonly collapsedSummaryKind?: 'turn' | 'assistant';
}

export interface TrajectoryVirtualRow {
  readonly entries: readonly TrajectoryVirtualRowEntry[];
  readonly height: number;
  readonly key: string;
}

/** Stable record identity; synthetic summaries get a suffix. */
export function trajectoryVirtualRecordKey(
  record: TrajectoryRecord,
  collapsedSummaryKind?: 'turn' | 'assistant',
): string {
  const identity = encodeURIComponent(record.id);
  return collapsedSummaryKind === undefined
    ? identity
    : `${identity}\u0000summary\u0000${collapsedSummaryKind}`;
}

/**
 * Attach request-only records to the next content row so the virtualizer
 * never owns a zero-height item; a terminal separator keeps its own
 * boundary row.
 */
export function groupTrajectoryVirtualRows(
  records: readonly TrajectoryRecord[],
): readonly TrajectoryVirtualRow[] {
  const rows: TrajectoryVirtualRow[] = [];
  let pending: TrajectoryVirtualRowEntry[] = [];

  for (const [logicalIndex, record] of records.entries()) {
    const entry: TrajectoryVirtualRowEntry = { logicalIndex, record };
    if (record.requestOnly === true) {
      pending.push(entry);
      continue;
    }
    const entries = [...pending, entry];
    pending = [];
    rows.push({
      entries,
      height: TRAJECTORY_CONTENT_ROW_HEIGHT,
      key: trajectoryVirtualRecordKey(record),
    });
  }

  if (pending.length > 0) {
    rows.push({
      entries: pending,
      height: TRAJECTORY_TERMINAL_BOUNDARY_HEIGHT,
      key: pending.map((candidate) => trajectoryVirtualRecordKey(candidate.record)).join('|'),
    });
  }

  return rows;
}

/**
 * Compute the visible row window for a scroll container.
 * @param rows - all virtual rows.
 * @param scrollTop - container scrollTop in px.
 * @param viewportHeight - container clientHeight in px.
 * @param overscan - extra rows rendered above/below the window.
 * @returns row indexes [start, end) plus the total content height.
 */
export function trajectoryVirtualWindow(
  rows: readonly TrajectoryVirtualRow[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 8,
): { readonly start: number; readonly end: number; readonly totalHeight: number } {
  const totalHeight = rows.reduce((sum, row) => sum + row.height, 0);
  if (rows.length === 0) {
    return { start: 0, end: 0, totalHeight: 0 };
  }
  // Binary-search the first row whose bottom is past scrollTop.
  let prefix = 0;
  let start = 0;
  let end = rows.length - 1;
  while (start <= end) {
    const mid = (start + end) >> 1;
    const row = rows[mid];
    if (row === undefined) break;
    const bottom = prefix + row.height;
    if (bottom <= scrollTop) {
      prefix = bottom;
      start = mid + 1;
    } else {
      end = mid - 1;
    }
  }
  const first = start;
  let acc = prefix;
  let last = first;
  const viewBottom = scrollTop + viewportHeight;
  while (last < rows.length && acc < viewBottom) {
    const row = rows[last];
    if (row === undefined) break;
    acc += row.height;
    last += 1;
  }
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(rows.length, last + overscan),
    totalHeight,
  };
}
