/**
 * CustomRegistryImportDialog — blue rounded box that collects a custom
 * registry URL and an optional Bearer token before importing the registry's
 * provider entries.
 *
 * Geometry mirrors `ApiKeyInputDialogComponent` so the chrome stays
 * consistent with the API-key login flow. Two fields, switched with
 * Tab / Shift-Tab / Up / Down; Enter advances to the next field (and submits
 * on the last field), Esc cancels. Only the URL is required — public
 * registries take an empty token.
 */

import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { currentTheme } from '#/tui/theme';
import { DialogMouse, inputPressAt, mouseDispatch, type InputFrame } from '#/tui/utils/mouse';

export interface CustomRegistryImportValue {
  readonly url: string;
  readonly apiKey?: string;
}

export type CustomRegistryImportResult =
  | { readonly kind: 'ok'; readonly value: CustomRegistryImportValue }
  | { readonly kind: 'cancel' };

function getTitle(): string {
  return t('tui.dialogs.customRegistryImport.title');
}
function getSubtitleDefault(): string {
  return t('tui.dialogs.customRegistryImport.subtitleDefault');
}
function getSubtitleUrlEmpty(): string {
  return t('tui.dialogs.customRegistryImport.subtitleUrlEmpty');
}
function getFooterNotLast(): string {
  return t('tui.dialogs.customRegistryImport.footerNotLast');
}
function getFooterLast(): string {
  return t('tui.dialogs.customRegistryImport.footerLast');
}

type FieldId = 'url' | 'token';

function maskInputLine(raw: string): string {
  const prefix = '> ';
  if (!raw.startsWith(prefix)) return raw;

  // Strip trailing padding spaces so they stay as spaces.
  let end = raw.length;
  while (end > prefix.length && raw[end - 1] === ' ') {
    end--;
  }
  const padding = raw.slice(end);
  const content = raw.slice(prefix.length, end);

  // Protect ANSI escape sequences (reverse-video cursor, IME marker, etc.)
  // while masking every other visible character.
  const parts = content.split(/(\u001B(?:\[[0-9;]*m|_pi:c\u0007))/);
  const maskedContent = parts
    .map((part, index) => {
      if (index % 2 === 1) return part; // ANSI sequence
      return part.replaceAll(/[^ ]/g, '•');
    })
    .join('');

  return prefix + maskedContent + padding;
}

export class CustomRegistryImportDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly urlInput = new Input();
  private readonly tokenInput = new Input();
  private readonly onDone: (result: CustomRegistryImportResult) => void;
  private activeField: FieldId = 'url';
  private done = false;
  private hint: 'none' | 'url-empty' = 'none';
  /** Where the last render put each input line, in the dialog's own frame. */
  private urlFrame: InputFrame = { row: -1, column: 0 };
  private tokenFrame: InputFrame = { row: -1, column: 0 };
  private readonly mouse = new DialogMouse(() => this.focused);

  constructor(onDone: (result: CustomRegistryImportResult) => void, defaultUrl: string = '') {
    super();
    this.onDone = onDone;
    if (defaultUrl.length > 0) this.urlInput.setValue(defaultUrl);
    // Enter on the URL field advances to the token field; Enter on the token
    // (last) field submits.
    this.urlInput.onSubmit = () => {
      this.focusField('token');
    };
    this.tokenInput.onSubmit = () => {
      this.handleSubmit();
    };
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
      this.toggleField();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.focusField('token');
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.focusField('url');
      return;
    }

    if (this.hint !== 'none') {
      this.hint = 'none';
    }

    if (this.activeField === 'url') {
      this.urlInput.handleInput(data);
    } else {
      this.tokenInput.handleInput(data);
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.urlInput.invalidate();
    this.tokenInput.invalidate();
  }

  override render(width: number): string[] {
    const dialogActive = this.focused && !this.done;
    this.urlInput.focused = dialogActive && this.activeField === 'url';
    this.tokenInput.focused = dialogActive && this.activeField === 'token';

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('primary', s);
    const titleStyled = currentTheme.boldFg('textStrong', getTitle());
    const subtitleText = this.hint === 'url-empty' ? getSubtitleUrlEmpty() : getSubtitleDefault();
    const subtitleStyled = currentTheme.fg('textDim', subtitleText);
    const footerStyled = currentTheme.fg(
      'textDim',
      this.activeField === 'url' ? getFooterNotLast() : getFooterLast(),
    );

    const urlLabelText = t('tui.dialogs.customRegistryImport.urlLabel');
    const tokenLabelText = t('tui.dialogs.customRegistryImport.tokenLabel');
    const urlLabelStyled =
      this.activeField === 'url'
        ? currentTheme.boldFg('accent', urlLabelText)
        : currentTheme.fg('textDim', urlLabelText);
    const tokenLabelStyled =
      this.activeField === 'token'
        ? currentTheme.boldFg('accent', tokenLabelText)
        : currentTheme.fg('textDim', tokenLabelText);

    const titleLine = truncateToWidth(titleStyled, innerWidth, '…');
    const subtitleLine = truncateToWidth(subtitleStyled, innerWidth, '…');
    const footerLine = truncateToWidth(footerStyled, innerWidth, '…');
    const urlLabelLine = truncateToWidth(urlLabelStyled, innerWidth, '…');
    const tokenLabelLine = truncateToWidth(tokenLabelStyled, innerWidth, '…');
    const urlInputLine = this.urlInput.render(innerWidth)[0] ?? '> ';
    const rawTokenInputLine = this.tokenInput.render(innerWidth)[0] ?? '> ';
    const tokenInputLine = maskInputLine(rawTokenInputLine);

    const contentLines: string[] = [
      titleLine,
      '',
      subtitleLine,
      '',
      urlLabelLine,
      urlInputLine,
      '',
      tokenLabelLine,
      tokenInputLine,
      '',
      footerLine,
    ];
    const urlIndex = contentLines.indexOf(urlInputLine);
    const tokenIndex = contentLines.indexOf(tokenInputLine);

    if (safeWidth < 4) {
      this.urlFrame = { row: 1 + urlIndex, column: 0 };
      this.tokenFrame = { row: 1 + tokenIndex, column: 0 };
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '…'))];
    }
    this.urlFrame = { row: 3 + urlIndex, column: 3 };
    this.tokenFrame = { row: 3 + tokenIndex, column: 3 };

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

  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    return mouseDispatch(this, event, this.mouseEvent(event));
  }

  private mouseEvent(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.done) return undefined;
    const handoff = this.mouse.handoff(event);
    if (handoff !== undefined) return handoff;

    const urlHit = inputPressAt(this.urlInput, event, this.urlFrame);
    if (urlHit !== undefined) {
      this.focusField('url');
      return urlHit;
    }
    const tokenHit = inputPressAt(this.tokenInput, event, this.tokenFrame);
    if (tokenHit !== undefined) {
      this.focusField('token');
      return tokenHit;
    }
    return undefined;
  }

  private toggleField(): void {
    this.focusField(this.activeField === 'url' ? 'token' : 'url');
  }

  private focusField(field: FieldId): void {
    this.hint = 'none';
    this.activeField = field;
  }

  private handleSubmit(): void {
    if (this.done) return;

    const urlValue = this.urlInput.getValue().trim();
    const tokenValue = this.tokenInput.getValue().trim();

    if (urlValue.length === 0) {
      this.hint = 'url-empty';
      this.activeField = 'url';
      return;
    }

    this.done = true;
    this.onDone({
      kind: 'ok',
      value: { url: urlValue, apiKey: tokenValue.length > 0 ? tokenValue : undefined },
    });
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}
