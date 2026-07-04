/**
 * Renders thinking content in the transcript.
 * Supports live in-place updates while thinking streams, then finalizes
 * without replacing the component.
 * Supports expand/collapse via Ctrl+O (shared with tool output).
 */

import { Text, truncateToWidth, type Component, type TUI } from '@moonshot-ai/pi-tui';

import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  MESSAGE_INDENT,
  THINKING_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

import { FixedHeightWindow } from './fixed-height-window';

export type ThinkingRenderMode = 'live' | 'finalized';

export class ThinkingComponent implements Component {
  private text: string;
  private showMarker: boolean;
  private mode: ThinkingRenderMode;
  private expanded = false;
  private readonly ui: TUI | undefined;
  private spinnerFrame = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | undefined;
  // Hold a single Text instance so pi-tui's (text, width) → lines cache
  // actually survives across renders. Re-constructing per render destroys
  // the cache and forces full re-wrap on every frame, which dominates CPU
  // once the transcript accumulates many finalized thinking blocks.
  private readonly textComponent: Text;

  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(
    text: string,
    showMarker: boolean = true,
    mode: ThinkingRenderMode = 'finalized',
    ui?: TUI,
  ) {
    this.text = text;
    this.showMarker = showMarker;
    this.mode = mode;
    this.ui = ui;
    this.textComponent = new Text(this.styled(text), 0, 0);
    if (mode === 'live') {
      this.startSpinner();
    }
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
  }

  invalidate(): void {
    this.markRenderDirty();
    this.textComponent.setText(this.styled(this.text));
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.markRenderDirty();
    this.textComponent.setText(this.styled(text));
  }

  private styled(text: string): string {
    return currentTheme.italicFg('textDim', text);
  }

  finalize(): void {
    this.mode = 'finalized';
    this.markRenderDirty();
    this.stopSpinner();
  }

  dispose(): void {
    this.stopSpinner();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.markRenderDirty();
  }

  render(width: number): string[] {
    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === width
    ) {
      return this.renderCache.lines;
    }

    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.text.length > 0 ? this.textComponent.render(contentWidth) : [''];

    let rendered: string[];
    if (this.mode === 'live') {
      const window = new FixedHeightWindow({
        height: THINKING_PREVIEW_LINES,
        tail: true,
        lines: contentLines,
      });
      const windowLines = window.render(contentWidth);
      const spinner = currentTheme.fg(
        'textDim',
        `${BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0]} `,
      );
      rendered = [
        '',
        spinner + currentTheme.fg('textDim', 'thinking...'),
        MESSAGE_INDENT + (windowLines[0] ?? ''),
        MESSAGE_INDENT + (windowLines[1] ?? ''),
      ];
    } else if (this.expanded) {
      // Expanded: show all content lines (no fixed height).
      const lines: string[] = [''];
      for (let i = 0; i < contentLines.length; i++) {
        const p = i === 0 && this.showMarker ? currentTheme.fg('textDim', STATUS_BULLET) : MESSAGE_INDENT;
        lines.push(p + contentLines[i]);
      }
      rendered = lines;
    } else {
      // Finalized, collapsed: fixed 4-row skeleton (blank + header + 2-row window).
      const window = new FixedHeightWindow({
        height: THINKING_PREVIEW_LINES,
        tail: false,
        lines: contentLines,
      });
      const windowLines = window.render(contentWidth);
      const first = windowLines[0] ?? '';
      const second = windowLines[1] ?? '';
      const header =
        (this.showMarker ? currentTheme.fg('textDim', STATUS_BULLET) : MESSAGE_INDENT) + first;
      let tailLine: string;
      if (contentLines.length > THINKING_PREVIEW_LINES) {
        const remaining = contentLines.length - THINKING_PREVIEW_LINES;
        const hint = `... (${String(remaining)} more lines, ctrl+o to expand)`;
        const indentWidth = Math.min(MESSAGE_INDENT.length, Math.max(0, width));
        const hintWidth = Math.max(0, width - indentWidth);
        tailLine = ' '.repeat(indentWidth) + currentTheme.dim(truncateToWidth(hint, hintWidth, '…'));
      } else {
        tailLine = ' ';
      }
      rendered = ['', header, MESSAGE_INDENT + second, tailLine];
    }

    if (isRenderCacheEnabled()) {
      this.renderCache = { width, lines: rendered };
    }
    return rendered;
  }

  private startSpinner(): void {
    if (this.ui === undefined || this.spinnerInterval !== undefined) return;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.markRenderDirty();
      this.ui?.requestRender();
    }, BRAILLE_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval === undefined) return;
    clearInterval(this.spinnerInterval);
    this.spinnerInterval = undefined;
  }
}
