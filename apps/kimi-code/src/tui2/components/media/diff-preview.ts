/**
 * TUI2 diff preview — forwarding layer.
 *
 * Status: REAL (tui2, minimal). The implementation lives in
 * `diff-preview.ts` (utility code, not JSX). This file exists only to
 * satisfy the tui2 mirror invariant; it intentionally does not
 * re-export to keep the lint graph acyclic (a self-export would cycle).
 */
export type { DiffLine, DiffLineKind, RenderDiffLinesOptions } from './diff-preview.js' // oxlint-disable-line import/no-self-import
export { computeDiffLines, renderDiffLines, renderDiffLinesClustered } from './diff-preview.js' // oxlint-disable-line import/no-self-import