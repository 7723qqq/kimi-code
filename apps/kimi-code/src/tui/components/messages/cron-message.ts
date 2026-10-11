import type { Component } from '@moonshot-ai/pi-tui';
import { Spacer, Text, visibleWidth } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { CronTranscriptData } from '#/tui/types';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

export class CronMessageComponent implements Component {
  private readonly spacer = new Spacer(1);
  private readonly title: string;
  private readonly detail: string | undefined;
  private readonly titleToken: keyof ColorPalette;
  // Hold one Text instance per wrapped block so pi-tui's (text, width) → lines
  // cache survives across renders instead of re-wrapping every frame.
  private readonly titleText: Text;
  private readonly detailText: Text | undefined;
  private readonly promptText: Text;
  private readonly prompt: string;
  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(prompt: string, data: CronTranscriptData) {
    const missed = data.missedCount !== undefined;
    this.title = missed
      ? t('tui.messages.cronMessage.missedTitle')
      : t('tui.messages.cronMessage.firedTitle');
    this.titleToken = data.stale === true || missed ? 'warning' : 'accent';
    this.detail = cronDetail(data);
    this.prompt = prompt;
    this.titleText = new Text(this.styledTitle(), 0, 0);
    this.detailText =
      this.detail === undefined ? undefined : new Text(this.styledDetail() ?? '', 0, 0);
    this.promptText = new Text(currentTheme.fg('text', prompt), 0, 0);
  }

  invalidate(): void {
    this.renderCache = undefined;
    this.titleText.setText(this.styledTitle());
    const detail = this.styledDetail();
    if (detail !== undefined) this.detailText?.setText(detail);
    this.promptText.setText(currentTheme.fg('text', this.prompt));
  }

  private styledTitle(): string {
    return currentTheme.boldFg(this.titleToken, this.title);
  }

  private styledDetail(): string | undefined {
    return this.detail === undefined ? undefined : currentTheme.fg('textDim', this.detail);
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

    const bullet = currentTheme.boldFg(this.titleToken, STATUS_BULLET);
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, safeWidth - bulletWidth);
    const continuationIndent = ' '.repeat(bulletWidth);
    const lines: string[] = [];

    for (const line of this.spacer.render(safeWidth)) {
      lines.push(line);
    }

    const titleLines = this.titleText.render(contentWidth);
    for (let i = 0; i < titleLines.length; i += 1) {
      lines.push(`${i === 0 ? bullet : continuationIndent}${titleLines[i]}`);
    }

    if (this.detailText !== undefined) {
      for (const line of this.detailText.render(contentWidth)) {
        lines.push(`${continuationIndent}${line}`);
      }
    }

    const promptLines = this.promptText.render(contentWidth);
    for (const line of promptLines) {
      lines.push(`${continuationIndent}${line}`);
    }

    if (isRenderCacheEnabled()) this.renderCache = { width: safeWidth, lines };
    return lines;
  }
}

function cronDetail(data: CronTranscriptData): string | undefined {
  const parts: string[] = [];
  if (data.cron !== undefined && data.cron.length > 0) parts.push(data.cron);
  if (data.jobId !== undefined && data.jobId.length > 0) {
    parts.push(t('tui.messages.cronMessage.job', { jobId: data.jobId }));
  }
  if (data.recurring === false) parts.push(t('tui.messages.cronMessage.oneShot'));
  if (data.coalescedCount !== undefined && data.coalescedCount > 1) {
    parts.push(t('tui.messages.cronMessage.coalesced', { count: data.coalescedCount }));
  }
  if (data.missedCount !== undefined) {
    parts.push(t('tui.messages.cronMessage.missed', { count: data.missedCount }));
  }
  if (data.stale === true) parts.push(t('tui.messages.cronMessage.finalDelivery'));
  return parts.length > 0 ? parts.join(' | ') : undefined;
}
