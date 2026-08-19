/**
 * TUI2 keybinding set — app-level shortcut definitions + leader chords.
 *
 * Mirrors `tui/keybindings.ts` without the pi-tui `KeybindingsManager`
 * plumbing: the tui2 shell binds keys through the opentui keymap
 * (`keymap.ts`), so this file keeps only the declarative data — the
 * shortcut catalog and the leader-chord map.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

/** App-level shortcut catalog (descriptions for the which-key overlay). */
export const KIMI_KEYBINDINGS = {
  'kimi.editor.ctrlD': { defaultKeys: 'ctrl+d', description: 'Exit (on empty input)' },
  'kimi.editor.ctrlC': { defaultKeys: 'ctrl+c', description: 'Interrupt stream / clear input' },
  'kimi.editor.ctrlG': { defaultKeys: 'ctrl+g', description: 'Edit in external editor' },
  'kimi.editor.ctrlO': { defaultKeys: 'ctrl+o', description: 'Toggle tool output' },
  'kimi.editor.ctrlS': { defaultKeys: 'ctrl+s', description: 'Steer / send queued' },
  'kimi.editor.ctrlB': { defaultKeys: 'ctrl+b', description: 'Detach background task' },
  'kimi.editor.ctrlT': { defaultKeys: 'ctrl+t', description: 'Toggle todo expand' },
  'kimi.editor.shiftTab': { defaultKeys: 'shift+tab', description: 'Toggle plan mode' },
  'kimi.editor.undo': { defaultKeys: 'ctrl+-', description: 'Undo' },
  'kimi.editor.escape': { defaultKeys: 'escape', description: 'Cancel / dismiss' },
  'kimi.editor.leader': { defaultKeys: 'ctrl+x', description: 'Leader key' },
  'kimi.editor.whichKey': { defaultKeys: 'ctrl+alt+k', description: 'Show keybindings' },
} as const;

// ---------------------------------------------------------------------------
// Leader key chords
// ---------------------------------------------------------------------------

export type LeaderAction =
  | 'external-editor'
  | 'model'
  | 'sessions'
  | 'new-session'
  | 'compact'
  | 'undo'
  | 'redo'
  | 'status'
  | 'sidebar'
  | 'theme'
  | 'agent'
  | 'help'
  | 'navigate'
  | 'agent-pane'
  | 'review';

/** Map a leader chord's printable key to the action it triggers. */
export const LEADER_ACTIONS: Readonly<Record<string, LeaderAction>> = {
  e: 'external-editor',
  m: 'model',
  l: 'sessions',
  n: 'new-session',
  c: 'compact',
  u: 'undo',
  r: 'redo',
  s: 'status',
  b: 'sidebar',
  t: 'theme',
  a: 'agent',
  h: 'help',
  v: 'navigate',
  p: 'agent-pane',
  d: 'review',
};

/** Leader chords in display order (used by the which-key overlay). */
export const LEADER_CHORDS: ReadonlyArray<{ readonly key: string; readonly action: LeaderAction }> =
  [
    { key: 'e', action: 'external-editor' },
    { key: 'm', action: 'model' },
    { key: 'l', action: 'sessions' },
    { key: 'n', action: 'new-session' },
    { key: 'c', action: 'compact' },
    { key: 'u', action: 'undo' },
    { key: 'r', action: 'redo' },
    { key: 's', action: 'status' },
    { key: 'b', action: 'sidebar' },
    { key: 't', action: 'theme' },
    { key: 'a', action: 'agent' },
    { key: 'h', action: 'help' },
    { key: 'v', action: 'navigate' },
    { key: 'p', action: 'agent-pane' },
    { key: 'd', action: 'review' },
  ];
