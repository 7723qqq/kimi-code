/**
 * WhichKeyComponent — a searchable command palette.
 *
 * Lists the leader-key chords and the app-level shortcuts in grouped
 * sections. Typing filters the list (opencode-style `mod+k` palette); `↑`/`↓`
 * move the selection, `Enter` executes the selected command, `Esc` closes.
 * Used in two modes:
 *  - `focusable: true` (default): a modal mounted via `mountEditorReplacement`
 *    (e.g. `ctrl+alt+k`). Search + execute are available.
 *  - `focusable: false`: a transient, non-focusable overlay shown while the
 *    leader key is armed. The editor keeps focus so the next key resolves the
 *    chord; the host removes the overlay when the chord fires or times out.
 */

import {
  Container,
  Key,
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { LEADER_CHORDS, type LeaderAction } from '#/tui/keybindings';
import { currentTheme } from '#/tui/theme';

export type ShortcutAction =
  | 'exit'
  | 'interrupt'
  | 'external-editor'
  | 'toggle-tool-output'
  | 'steer'
  | 'detach'
  | 'toggle-todo'
  | 'plan-mode'
  | 'undo'
  | 'escape'
  | 'which-key'
  | 'navigate'
  | 'agent-pane'
  | 'review'
  | 'newline';

export type WhichKeyAction = LeaderAction | ShortcutAction;

export interface WhichKeyOptions {
  readonly onClose?: () => void;
  /** Fired when the user executes a command from the palette. */
  readonly onSelect?: (action: WhichKeyAction) => void;
  /** When false the overlay is non-focusable (leader mode) and never closes itself. */
  readonly focusable?: boolean;
}

interface CommandEntry {
  readonly keys: string;
  readonly label: string;
  readonly action: WhichKeyAction;
  readonly section: 'leader' | 'shortcuts';
}

export class WhichKeyComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: WhichKeyOptions;
  private query = '';
  private selectedIndex = 0;
  private scrollTop = 0;

  constructor(opts: WhichKeyOptions = {}) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    if (this.opts.focusable === false) return;
    const printable = decodeKittyPrintable(data) ?? data;

    if (matchesKey(data, Key.escape) || printable === 'q' || printable === 'Q') {
      this.opts.onClose?.();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const entry = this.filteredEntries()[this.selectedIndex];
      if (entry !== undefined) {
        this.opts.onSelect?.(entry.action);
      }
      this.opts.onClose?.();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.query = this.query.slice(0, -1);
      this.selectedIndex = 0;
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTop = Math.max(0, this.scrollTop - 10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTop += 10;
      return;
    }
    // Printable characters extend the filter query.
    if (printable.length === 1 && !printable.startsWith('\x1b')) {
      this.query += printable;
      this.selectedIndex = 0;
    }
  }

  private move(delta: number): void {
    const entries = this.filteredEntries();
    if (entries.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + entries.length) % entries.length;
  }

  private filteredEntries(): CommandEntry[] {
    const q = this.query.trim().toLowerCase();
    if (q.length === 0) return ALL_ENTRIES;
    return ALL_ENTRIES.filter(
      (e) => e.label.toLowerCase().includes(q) || e.keys.toLowerCase().includes(q),
    );
  }

  override render(width: number): string[] {
    const accent = (s: string) => currentTheme.fg('primary', s);
    const dim = (s: string) => currentTheme.fg('textDim', s);
    const muted = (s: string) => currentTheme.fg('textMuted', s);
    const kbd = (s: string) => currentTheme.fg('warning', s);

    const entries = this.filteredEntries();
    const lines: string[] = [
      accent('─'.repeat(width)),
      currentTheme.boldFg('primary', t('tui.dialogs.whichKey.title')) +
        muted(t('tui.dialogs.whichKey.cancelHint')),
      '',
    ];

    if (this.opts.focusable !== false) {
      // Search line (opencode-style palette filter).
      const searchLabel = t('tui.dialogs.whichKey.searchLabel');
      lines.push(
        `  ${currentTheme.fg('text', searchLabel)}${currentTheme.fg('text', this.query)}`,
        '',
      );
    }

    if (entries.length === 0) {
      lines.push(muted(`  ${t('tui.dialogs.whichKey.noMatches')}`), '');
    } else {
      let lastSection: 'leader' | 'shortcuts' | undefined;
      for (const [i, entry] of entries.entries()) {
        if (entry.section !== lastSection) {
          lastSection = entry.section;
          lines.push(
            `  ${currentTheme.bold(
              entry.section === 'leader'
                ? t('tui.dialogs.whichKey.leaderSection')
                : t('tui.dialogs.whichKey.shortcutsSection'),
            )}`,
          );
        }
        const selected = i === this.selectedIndex;
        const row = `    ${kbd(entry.keys.padEnd(14))}  ${dim(entry.label)}`;
        lines.push(selected ? currentTheme.bg('accent', currentTheme.fg('text', row)) : row);
      }
      lines.push('');
    }

    lines.push(accent('─'.repeat(width)));

    // Keep the borders visible and window the content on short terminals.
    const content = lines.slice(1, lines.length - 1);
    const maxVisible = Math.max(5, this.opts.focusable === false ? 12 : 24);
    if (content.length > maxVisible) {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, content.length - maxVisible));
      const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
      const from = this.scrollTop + 1;
      const to = this.scrollTop + slice.length;
      const scrollInfo = muted(
        t('tui.dialogs.helpPanel.showing', { from, to, total: content.length }),
      );
      return [lines[0] ?? '', ...slice, scrollInfo, lines.at(-1) ?? ''].map((line) =>
        truncateToWidth(line, width),
      );
    }
    this.scrollTop = 0;
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function leaderActionLabelKey(action: LeaderAction): string {
  switch (action) {
    case 'external-editor':
      return 'tui.dialogs.whichKey.actions.externalEditor';
    case 'model':
      return 'tui.dialogs.whichKey.actions.model';
    case 'sessions':
      return 'tui.dialogs.whichKey.actions.sessions';
    case 'new-session':
      return 'tui.dialogs.whichKey.actions.newSession';
    case 'compact':
      return 'tui.dialogs.whichKey.actions.compact';
    case 'undo':
      return 'tui.dialogs.whichKey.actions.undo';
    case 'redo':
      return 'tui.dialogs.whichKey.actions.redo';
    case 'status':
      return 'tui.dialogs.whichKey.actions.status';
    case 'sidebar':
      return 'tui.dialogs.whichKey.actions.sidebar';
    case 'theme':
      return 'tui.dialogs.whichKey.actions.theme';
    case 'agent':
      return 'tui.dialogs.whichKey.actions.agent';
    case 'help':
      return 'tui.dialogs.whichKey.actions.help';
    case 'navigate':
      return 'tui.dialogs.whichKey.actions.navigate';
    case 'agent-pane':
      return 'tui.dialogs.whichKey.actions.agentPane';
    case 'review':
      return 'tui.dialogs.whichKey.actions.review';
  }
}

function shortcutLabelKey(action: ShortcutAction): string {
  switch (action) {
    case 'exit':
      return 'tui.dialogs.whichKey.shortcuts.ctrlD';
    case 'interrupt':
      return 'tui.dialogs.whichKey.shortcuts.ctrlC';
    case 'external-editor':
      return 'tui.dialogs.whichKey.shortcuts.ctrlG';
    case 'toggle-tool-output':
      return 'tui.dialogs.whichKey.shortcuts.ctrlO';
    case 'steer':
      return 'tui.dialogs.whichKey.shortcuts.ctrlS';
    case 'detach':
      return 'tui.dialogs.whichKey.shortcuts.ctrlB';
    case 'toggle-todo':
      return 'tui.dialogs.whichKey.shortcuts.ctrlT';
    case 'plan-mode':
      return 'tui.dialogs.whichKey.shortcuts.shiftTab';
    case 'undo':
      return 'tui.dialogs.whichKey.shortcuts.undo';
    case 'escape':
      return 'tui.dialogs.whichKey.shortcuts.escape';
    case 'which-key':
      return 'tui.dialogs.whichKey.shortcuts.whichKey';
    case 'navigate':
      return 'tui.dialogs.whichKey.shortcuts.transcriptNav';
    case 'agent-pane':
      return 'tui.dialogs.whichKey.shortcuts.agentPane';
    case 'review':
      return 'tui.dialogs.whichKey.shortcuts.review';
    case 'newline':
      return 'tui.dialogs.whichKey.shortcuts.newLine';
  }
}

const ALL_ENTRIES: CommandEntry[] = [
  ...LEADER_CHORDS.map(({ key, action }) => ({
    keys: `Ctrl-X ${key}`,
    label: t(leaderActionLabelKey(action)),
    action,
    section: 'leader' as const,
  })),
  ...(
    [
      ['Ctrl-D', 'exit'],
      ['Ctrl-C', 'interrupt'],
      ['Ctrl-G', 'external-editor'],
      ['Ctrl-O', 'toggle-tool-output'],
      ['Ctrl-S', 'steer'],
      ['Ctrl-B', 'detach'],
      ['Ctrl-T', 'toggle-todo'],
      ['Shift-Tab', 'plan-mode'],
      ['Ctrl--', 'undo'],
      ['Esc', 'escape'],
      ['Ctrl-Alt-K', 'which-key'],
      ['Ctrl-X V', 'navigate'],
      ['Ctrl-X P', 'agent-pane'],
      ['Ctrl-X D', 'review'],
      ['Shift-Enter / Ctrl-J', 'newline'],
    ] as const
  ).map(([keys, action]) => ({
    keys,
    label: t(shortcutLabelKey(action)),
    action,
    section: 'shortcuts' as const,
  })),
];
