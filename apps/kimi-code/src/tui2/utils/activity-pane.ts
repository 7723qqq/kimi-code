/**
 * TUI2 activity-pane helpers — pure derivations for the right-hand activity
 * pane: which loading tip to show for a streaming phase, and array equality
 * for the additional-dirs diff.
 *
 * Extracted from `controllers/kimi-tui.ts` (the 3700-line host class).
 *
 * Status: REAL (tui2). New file — no v1 counterpart.
 */

export type EffectiveActivityPaneMode =
  | 'idle'
  | 'waiting'
  | 'thinking'
  | 'composing'
  | 'shell'
  | 'session'
  | 'hidden'
  | 'tool';

export type LoadingTipKind = 'moon' | 'composing';

/** Which loading tip the activity pane shows for a streaming phase. */
export function loadingTipKind(mode: EffectiveActivityPaneMode): LoadingTipKind | undefined {
  if (mode === 'waiting' || mode === 'tool') return 'moon';
  if (mode === 'composing') return 'composing';
  return undefined;
}

/** Reference equality per element — used to diff the additional-dirs list. */
export function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
