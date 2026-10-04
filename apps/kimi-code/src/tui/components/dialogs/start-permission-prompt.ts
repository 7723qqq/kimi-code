import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { wrapText as wrapPlain } from '#/tui/utils/wrap-text';

export type StartPermissionChoice = 'auto' | 'yolo' | 'manual' | 'cancel';

export interface StartPermissionOption<
  TChoice extends StartPermissionChoice = StartPermissionChoice,
> {
  readonly value: TChoice;
  readonly label: string;
  readonly description: string;
}

export interface StartPermissionPromptOptions<
  TChoice extends StartPermissionChoice = StartPermissionChoice,
> {
  readonly title: string;
  readonly noticeLines: readonly string[];
  readonly options: readonly StartPermissionOption<TChoice>[];
  readonly onSelect: (choice: TChoice) => void;
  readonly onCancel: () => void;
}

export class StartPermissionPromptComponent<
  TChoice extends StartPermissionChoice = StartPermissionChoice,
>
  implements Component, Focusable
{
  focused = false;
  private selectedIndex = 0;

  constructor(private readonly opts: StartPermissionPromptOptions<TChoice>) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.opts.options.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.opts.onSelect(this.opts.options[this.selectedIndex]!.value);
    }
  }

  render(width: number): string[] {
    const rule = currentTheme.fg('primary', '─'.repeat(width));
    const lines = [
      rule,
      currentTheme.boldFg('primary', ` ${this.opts.title}`),
      currentTheme.fg('textMuted', ` ${t('tui.dialogs.startPermissionPrompt.navHint')}`),
      '',
    ];

    const textWidth = Math.max(20, width - 2);
    for (const paragraph of this.opts.noticeLines) {
      for (const line of wrapPlain(paragraph, textWidth)) {
        lines.push(` ${styleModeNames(line, 'textMuted')}`);
      }
      lines.push('');
    }

    for (let i = 0; i < this.opts.options.length; i += 1) {
      const option = this.opts.options[i]!;
      const selected = i === this.selectedIndex;
      const pointer = selected ? SELECT_POINTER : ' ';
      lines.push(
        currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `) +
          styleLabel(option.label, selected),
      );
      for (const line of wrapPlain(option.description, Math.max(20, width - 4))) {
        lines.push(`    ${styleModeNames(line, 'textMuted')}`);
      }
      lines.push('');
    }

    lines.push(rule);
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function styleLabel(label: string, selected: boolean): string {
  if (selected) return currentTheme.boldFg('primary', label);
  return styleModeNames(label, 'text');
}

function styleModeNames(text: string, baseToken: 'text' | 'textMuted'): string {
  return text
    .split(/(\b(?:Manual|Auto|YOLO)\b)/g)
    .map((part) => {
      if (part === 'Manual' || part === 'Auto' || part === 'YOLO')
        return currentTheme.boldFg('textStrong', part);
      return currentTheme.fg(baseToken, part);
    })
    .join('');
}
