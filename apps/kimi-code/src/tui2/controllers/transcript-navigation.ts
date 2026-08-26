/**
 * TUI2 transcript navigation controller — keyboard-driven message navigation.
 *
 * Mirrors `tui/controllers/transcript-navigation.ts`. While active, `j`/`k`
 * (or ↑/↓) move between expandable transcript blocks, `Enter` toggles the
 * focused block's expansion, and `Esc` exits. The v1 controller walked the
 * pi-tui Container tree and called component hooks (`setNavigated`,
 * `setExpanded`); the tui2 version tracks the focus index in
 * `store.state.transcriptNav` and flags entries via `expanded`/`navigated`
 * on the transcript entries themselves — the opentui reconciler re-renders
 * the focused block automatically.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import { printableChar } from '../utils/printable-key';
import type { Tui2Store } from '../state';
import type { TranscriptEntry, TranscriptEntryKind } from '../types';

/** Entry kinds the navigation mode can focus. */
const NAVIGABLE_KINDS = new Set<TranscriptEntryKind>([
  'user',
  'assistant',
  'tool_call',
  'thinking',
  'goal',
]);

/** Entry kinds that are expandable (toggle on Enter). */
const EXPANDABLE_KINDS = new Set<TranscriptEntryKind>(['tool_call', 'thinking', 'goal']);

export interface TranscriptNavController {
  isActive(): boolean;
  /** Handle a key while navigation is active. Returns true when consumed. */
  handleKey(data: string): boolean;
  toggle(): void;
  activate(): void;
  deactivate(): void;
  move(delta: number): void;
  toggleExpandFocused(): void;
}

export function createTranscriptNavController(store: Tui2Store): TranscriptNavController {
  const navigableEntries = (): TranscriptEntry[] =>
    store.state.transcript.filter((entry) => NAVIGABLE_KINDS.has(entry.kind));

  const clearNavigated = (): void => {
    store.setState('transcript', (entries) =>
      entries.map((entry) => (entry.navigated ? { ...entry, navigated: false } : entry)),
    );
  };

  const applyNavigated = (index: number): void => {
    const entries = navigableEntries();
    const focused = entries[index];
    if (focused === undefined) return;
    store.setState('transcript', (all) =>
      all.map((entry) =>
        entry.id === focused.id ? { ...entry, navigated: true } : entry,
      ),
    );
  };

  const scrollToFocused = (): void => {
    // Scrolling is owned by the transcript view (opentui ScrollView); the
    // store index is the source of truth the view reads to bring the focused
    // entry into view.
    store.setState('transcriptNav', { index: store.state.transcriptNav.index });
  };

  const activate = (): void => {
    if (store.state.transcriptNav.active) return;
    if (navigableEntries().length === 0) return;
    const index = Math.min(store.state.transcriptNav.index, navigableEntries().length - 1);
    store.setState('transcriptNav', { active: true, index });
    applyNavigated(index);
    scrollToFocused();
  };

  const deactivate = (): void => {
    if (!store.state.transcriptNav.active) return;
    store.setState('transcriptNav', { active: false });
    clearNavigated();
  };

  const move = (delta: number): void => {
    const entries = navigableEntries();
    if (entries.length === 0) return;
    clearNavigated();
    const index =
      (store.state.transcriptNav.index + delta + entries.length) % entries.length;
    store.setState('transcriptNav', { index });
    applyNavigated(index);
    scrollToFocused();
  };

  const toggleExpandFocused = (): void => {
    const entries = navigableEntries();
    const focused = entries[store.state.transcriptNav.index];
    if (focused === undefined || !EXPANDABLE_KINDS.has(focused.kind)) return;
    store.setState('transcript', (all) =>
      all.map((entry) =>
        entry.id === focused.id ? { ...entry, expanded: !entry.expanded } : entry,
      ),
    );
  };

  const handleKey = (data: string): boolean => {
    if (!store.state.transcriptNav.active) return false;

    if (data === '\u001B' || data === 'escape') {
      deactivate();
      return true;
    }
    if (data === '\r' || data === '\n' || data === 'enter') {
      toggleExpandFocused();
      return true;
    }
    if (data === '\u001B[B' || data === 'down') {
      move(1);
      return true;
    }
    if (data === '\u001B[A' || data === 'up') {
      move(-1);
      return true;
    }
    // Printables may arrive as Kitty CSI-u sequences; decode before comparing.
    const ch = printableChar(data);
    if (ch === 'j') {
      move(1);
      return true;
    }
    if (ch === 'k') {
      move(-1);
      return true;
    }
    return false;
  };

  return {
    isActive: () => store.state.transcriptNav.active,
    handleKey,
    toggle(): void {
      if (store.state.transcriptNav.active) {
        deactivate();
      } else {
        activate();
      }
    },
    activate,
    deactivate,
    move,
    toggleExpandFocused,
  };
}
