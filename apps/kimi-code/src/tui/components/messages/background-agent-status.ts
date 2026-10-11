import { Text, truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { FAILURE_MARK, STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { BackgroundAgentStatusData } from '#/tui/types';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

export class BackgroundAgentStatusComponent implements Component {
  // Hold a single Text instance so pi-tui's (text, width) → lines cache
  // survives across renders; re-constructing per render would re-wrap the
  // headline on every frame.
  private readonly textComponent: Text;
  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(private readonly data: BackgroundAgentStatusData) {
    this.textComponent = new Text(this.styled(), 0, 0);
  }

  invalidate(): void {
    this.renderCache = undefined;
    this.textComponent.setText(this.styled());
  }

  private tone(): keyof ColorPalette {
    return this.data.phase === 'started'
      ? 'primary'
      : this.data.phase === 'completed'
        ? 'success'
        : 'error';
  }

  private styled(): string {
    const tone = this.tone();
    const detail =
      this.data.detail !== undefined && this.data.detail.length > 0
        ? currentTheme.fg(
            'textDim',
            t('tui.messages.backgroundAgentStatus.detail', { detail: this.data.detail }),
          )
        : '';
    return currentTheme.fg(tone, this.data.headline) + detail;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === safeWidth
    ) {
      return this.renderCache.lines;
    }

    const tone = this.tone();
    const bullet =
      this.data.phase === 'failed' || this.data.phase === 'killed'
        ? currentTheme.fg(tone, FAILURE_MARK)
        : currentTheme.fg(tone, STATUS_BULLET);
    const contentWidth = Math.max(1, safeWidth - MESSAGE_INDENT.length);
    const contentLines = this.textComponent.render(contentWidth);
    const rendered = [
      '',
      ...contentLines.map((line, index) => (index === 0 ? bullet : MESSAGE_INDENT) + line),
    ].map((line) => truncateToWidth(line, safeWidth, '…'));
    if (isRenderCacheEnabled()) this.renderCache = { width: safeWidth, lines: rendered };
    return rendered;
  }
}
