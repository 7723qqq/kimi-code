import {
  Container,
  Editor,
  isKeyRelease,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type TUI,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { normalizeCapsLockedCtrl } from '#/tui/components/editor/custom-editor';
import { currentTheme } from '#/tui/theme';
import { createEditorTheme } from '#/tui/theme/pi-tui-theme';
import { mouseDispatch } from '#/tui/utils/mouse';

export type FeedbackInputDialogResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancel' };

const MIN_FIELD_LINES = 3;

class FeedbackField extends Editor {
  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    return hiddenLineCount > 0 ? super.renderTopBorder(width, hiddenLineCount) : '';
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    return hiddenLineCount > 0 ? super.renderBottomBorder(width, hiddenLineCount) : '';
  }
}

function getTitle(): string {
  return t('tui.dialogs.feedbackInput.title');
}
function getSubtitleDefault(): string {
  return t('tui.dialogs.feedbackInput.subtitleDefault');
}
function getSubtitleEmpty(): string {
  return t('tui.dialogs.feedbackInput.subtitleEmpty');
}
function getFooter(): string {
  return t('tui.dialogs.feedbackInput.footer');
}

export class FeedbackInputDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly input: FeedbackField;
  private readonly onDone: (result: FeedbackInputDialogResult) => void;
  private done = false;
  private emptyHinted = false;
  private inputFrame = { row: -1, column: 3 };

  constructor(tui: TUI, onDone: (result: FeedbackInputDialogResult) => void) {
    super();
    this.onDone = onDone;
    this.input = new FeedbackField(tui, createEditorTheme(), { paddingX: 1 });
    this.input.onSubmit = (value) => {
      this.submit(value);
    };
    this.input.onChange = () => {
      this.emptyHinted = false;
    };
  }

  handleInput(data: string): void {
    const key = normalizeCapsLockedCtrl(data);
    if (this.done || isKeyRelease(key)) return;
    if (
      matchesKey(key, Key.escape) ||
      matchesKey(key, Key.ctrl('c')) ||
      matchesKey(key, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }
    this.input.handleInput(key);
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    if (this.done || this.inputFrame.row < 0 || event.y < this.inputFrame.row) return undefined;
    this.focused = true;
    this.input.focused = true;
    const result = this.input.handleMouse({
      ...event,
      x: Math.max(0, event.x - this.inputFrame.column),
      y: event.y - this.inputFrame.row + 1,
    });
    return mouseDispatch(this, event, result);
  }

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  override render(width: number): string[] {
    this.input.focused = this.focused && !this.done;

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('primary', s);
    const titleStyled = currentTheme.boldFg('textStrong', getTitle());
    const subtitleText = this.emptyHinted ? getSubtitleEmpty() : getSubtitleDefault();
    const subtitleStyled = currentTheme.fg('textDim', subtitleText);
    const footerStyled = currentTheme.fg('textDim', getFooter());

    const titleLine = truncateToWidth(titleStyled, innerWidth, '…');
    const subtitleLine = truncateToWidth(subtitleStyled, innerWidth, '…');
    const footerLine = truncateToWidth(footerStyled, innerWidth, '…');

    const rendered = this.input.render(Math.max(1, innerWidth - 2));
    const hasBorders = rendered.length >= 2;
    const body = hasBorders ? rendered.slice(1, -1) : [...rendered];
    while (body.length < MIN_FIELD_LINES) body.push('');
    const bodyLines = body.map((line) => truncateToWidth(line, innerWidth, '…'));

    const bodyIndex = 4;
    const contentLines: string[] = [
      titleLine,
      '',
      subtitleLine,
      '',
      ...bodyLines,
      '',
      footerLine,
    ];

    if (safeWidth < 4) {
      this.inputFrame = { row: 1 + bodyIndex, column: 0 };
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '…'))];
    }
    this.inputFrame = { row: 3 + bodyIndex, column: 3 };

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      const vis = visibleWidth(content);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private submit(value: string): void {
    if (this.done) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      this.emptyHinted = true;
      return;
    }
    this.done = true;
    this.onDone({ kind: 'ok', value: trimmed });
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}
