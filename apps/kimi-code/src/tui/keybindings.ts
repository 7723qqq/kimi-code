/**
 * kimi-code keybinding set.
 *
 * Extends pi-tui's `Keybindings` interface via declaration merging and defines
 * the default keys for every app-level shortcut that `CustomEditor` used to
 * hard-code with `matchesKey`. The merged manager is installed globally so
 * pi-tui's own `Editor` (which reads `getKeybindings()`) and `CustomEditor`
 * share the same resolved bindings.
 *
 * The leader key (`ctrl+x`) is a prefix chord: pressing it arms a short
 * window during which the next printable key selects an action (see
 * `LEADER_ACTIONS`). `ctrl+alt+k` opens the which-key overlay.
 */

import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  type KeybindingDefinitions,
} from '@moonshot-ai/pi-tui';

declare module '@moonshot-ai/pi-tui' {
  interface Keybindings {
    'kimi.editor.ctrlD': true;
    'kimi.editor.ctrlC': true;
    'kimi.editor.ctrlG': true;
    'kimi.editor.ctrlO': true;
    'kimi.editor.ctrlS': true;
    'kimi.editor.ctrlB': true;
    'kimi.editor.ctrlT': true;
    'kimi.editor.shiftTab': true;
    'kimi.editor.undo': true;
    'kimi.editor.escape': true;
    'kimi.editor.leader': true;
    'kimi.editor.whichKey': true;
  }
}

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
} as const satisfies KeybindingDefinitions;

let manager: KeybindingsManager | null = null;

/**
 * The merged kimi-code + pi-tui keybinding manager. Lazily created and
 * installed as the global manager so pi-tui's `Editor` and `CustomEditor`
 * resolve the same keys.
 */
export function getKimiKeybindings(): KeybindingsManager {
  if (manager === null) {
    manager = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...KIMI_KEYBINDINGS });
    setKeybindings(manager);
  }
  return manager;
}

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
