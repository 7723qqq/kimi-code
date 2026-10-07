/**
 * PromptOptimizePanel — shows the model's rewrite of the drafted prompt
 * against the original and asks the user to accept or discard it.
 *
 * Mirrors the container-replacement pattern: the host mounts it over the
 * editor, the user picks accept/discard, and the host tears it down and
 * applies the accepted text back into the editor.
 */

import { Container, matchesKey, Key, truncateToWidth, type Focusable } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

export type PromptOptimizeChoice = 'accept' | 'discard';

export interface PromptOptimizePanelOptions {
  readonly original: string;
  readonly optimized: string;
  readonly onSelect: (choice: PromptOptimizeChoice) => void;
}

const MAX_DIFF_LINES = 24;

export class PromptOptimizePanelComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: PromptOptimizePanelOptions;
  private selected: PromptOptimizeChoice = 'accept';

  constructor(opts: PromptOptimizePanelOptions) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onSelect('discard');
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
      this.selected = 'accept';
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
      this.selected = 'discard';
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.opts.onSelect(this.selected);
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.selected = this.selected === 'accept' ? 'discard' : 'accept';
    }
  }

  override render(width: number): string[] {
    const theme = currentTheme;
    const lines: string[] = [
      theme.fg('primary', '─'.repeat(Math.max(1, width))),
      theme.boldFg('primary', t('tui.dialogs.promptOptimize.title')),
      theme.fg(
        'textMuted',
        t('tui.dialogs.promptOptimize.hint', { accept: 'Enter', discard: 'Esc' }),
      ),
      '',
    ];
    for (const line of renderDiffLinesClustered(this.opts.original, this.opts.optimized, '', {
      contextLines: 2,
      maxLines: MAX_DIFF_LINES,
    })) {
      lines.push(truncateToWidth(line, width));
    }
    lines.push('');
    lines.push(this.choiceLine('accept', width));
    lines.push(this.choiceLine('discard', width));
    lines.push('');
    lines.push(theme.fg('primary', '─'.repeat(Math.max(1, width))));
    return lines;
  }

  private choiceLine(choice: PromptOptimizeChoice, width: number): string {
    const theme = currentTheme;
    const label =
      choice === 'accept'
        ? t('tui.dialogs.promptOptimize.accept')
        : t('tui.dialogs.promptOptimize.discard');
    const isSelected = this.selected === choice;
    const pointer = isSelected ? SELECT_POINTER : '  ';
    const text = isSelected ? theme.boldFg('primary', label) : theme.fg('text', label);
    return truncateToWidth(`${pointer}${text}`, width);
  }
}
