/**
 * OAuth device-code panel rendered inside the transcript.
 *
 * Uses the shared panel frame (`renderPanelFrame`) so the login prompt matches
 * the rest of the transcript's boxed panels. All colors flow through the active
 * palette so theme switches take effect on the next render.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { PANEL_INDENT, PANEL_SIDE_PADDING } from '#/tui/constant/panel';
import { currentTheme } from '#/tui/theme';

import { renderPanelFrame } from './panel-frame';

export interface DeviceCodeBoxParams {
  readonly title: string;
  readonly url: string;
  /** Verification code row; omitted for plain browser (no user code) flows. */
  readonly code?: string;
  readonly hint?: string;
}

export class DeviceCodeBoxComponent implements Component {
  private readonly params: DeviceCodeBoxParams;

  constructor(params: DeviceCodeBoxParams) {
    this.params = params;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { title, url, code, hint } = this.params;
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    // Pre-clip content to the frame's interior so a truncated URL keeps its
    // ellipsis on the last visible cell instead of being clipped away by the
    // frame's border padding.
    const innerWidth = Math.max(1, safeWidth - (PANEL_INDENT + 2 + 2 * PANEL_SIDE_PADDING));

    const promptLine = truncateToWidth(
      currentTheme.fg('textDim', t('tui.chrome.deviceCodeBox.prompt')),
      innerWidth,
      '…',
    );
    const urlLine = truncateToWidth(currentTheme.fg('primary', url), innerWidth, '…');

    const contentLines: string[] = [promptLine, urlLine];
    if (code !== undefined && code.length > 0) {
      const codeLabel = currentTheme.boldFg('textDim', t('tui.chrome.deviceCodeBox.codeLabel'));
      const codeValue = currentTheme.boldFg('accent', code);
      contentLines.push('', truncateToWidth(`${codeLabel}${codeValue}`, innerWidth, '…'));
    }
    if (hint !== undefined && hint.length > 0) {
      contentLines.push('');
      contentLines.push(truncateToWidth(currentTheme.fg('textDim', hint), innerWidth, '…'));
    }

    return [
      '',
      ...renderPanelFrame({
        title,
        body: contentLines,
        width: safeWidth,
        titlePaint: (text) => currentTheme.boldFg('primary', text),
        stretch: true,
      }),
      '',
    ];
  }
}
