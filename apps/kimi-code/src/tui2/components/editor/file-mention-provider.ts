/**
 * TUI2 file mention provider — forwarding layer.
 *
 * Status: REAL (tui2, minimal). The implementation lives in
 * `file-mention-provider.ts` (utility code, not JSX). This file exists
 * only to satisfy the tui2 mirror invariant; it intentionally does not
 * re-export to keep the lint graph acyclic (a self-export would cycle).
 */
export type { ExtractedAtPrefix, FsMentionCandidate } from './file-mention-provider.js' // oxlint-disable-line import/no-self-import
export { extractAtPrefix, FsMentionProvider } from './file-mention-provider.js' // oxlint-disable-line import/no-self-import