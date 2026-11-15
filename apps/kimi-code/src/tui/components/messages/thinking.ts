/**
 * Renders thinking content in the transcript.
 * Supports live in-place updates while thinking streams, then finalizes
 * without replacing the component.
 * Supports expand/collapse via Ctrl+O (shared with tool output).
 */

import {
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { ButtonComponent } from '#/tui/components/chrome/button';
import { renderHeaderContent } from '#/tui/components/messages/truncated-header-line';
import {
  ANSI_ESCAPE_PATTERN,
  MESSAGE_INDENT,
  THINKING_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { Elapsed } from '#/tui/types';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { elapsedSuffix, shownSeconds, TitleSweep } from './running-title';

const FINALIZED_FOLD_HINT_ROWS = 1;

export type ThinkingRenderMode = 'live' | 'finalized';

export type FinishedThinkingForm =
  | { readonly kind: 'standalone' }
  | { readonly kind: 'opened'; readonly title: string };

export class ThinkingComponent implements Component {
  /** When this block started; group rows and the live title timer count from here. */
  readonly startedAtMs = Date.now();

  private text: string;
  private showMarker: boolean;
  private mode: ThinkingRenderMode;
  private finishedForm: FinishedThinkingForm = { kind: 'standalone' };
  private expanded = false;
  private previewHidesLines = false;
  private readonly ui: TUI | undefined;
  private readonly sweep = new TitleSweep();
  private frameRequest: number | undefined;
  private shownAnimation: string | undefined;
  private elapsed: Elapsed | undefined;
  private projectionVersion = 0;
  private liveTitle = '';
  private onToggle: (() => void) | undefined;
  private readonly headerButton: ButtonComponent;
  // Hold a single Text instance so pi-tui's (text, width) → lines cache
  // actually survives across renders. Re-constructing per render destroys
  // the cache and forces full re-wrap on every frame, which dominates CPU
  // once the transcript accumulates many finalized thinking blocks.
  private readonly textComponent: Text;

  private renderCache: { width: number; lines: string[] } | undefined;
  private rowDetailCache: { width: number; lines: string[] } | undefined;

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
    this.elapsed = mode === 'live' ? undefined : { known: false };
    this.textComponent = new Text(this.styled(text), 0, 0);
    this.headerButton = new ButtonComponent(
      () => this.liveTitle,
      () => this.onToggle?.(),
    );
    if (mode === 'live') {
      this.startFrames();
    }
  }

  setToggleHandler(handler: (() => void) | undefined): void {
    this.onToggle = handler;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.mode !== 'live' || this.onToggle === undefined) return undefined;
    if (event.y !== 1) return undefined;
    return this.headerButton.handleMouse({ ...event, y: 0, height: 1 });
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
    this.rowDetailCache = undefined;
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

  finalize(elapsed: Elapsed = { known: false }): void {
    this.elapsed = elapsed;
    this.projectionVersion += 1;
    this.mode = 'finalized';
    this.markRenderDirty();
    this.stopFrames();
  }

  get thinkingElapsed(): Elapsed | undefined {
    return this.elapsed;
  }

  get transcriptProjectionVersion(): number {
    return this.projectionVersion;
  }

  dispose(): void {
    this.stopFrames();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.markRenderDirty();
  }

  setFinishedForm(form: FinishedThinkingForm): void {
    if (sameFinishedForm(this.finishedForm, form)) return;
    this.finishedForm = form;
    this.markRenderDirty();
  }

  hasHiddenContent(): boolean {
    return this.previewHidesLines;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  omitsExpandHint(): boolean {
    return true;
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
      const streamed = withoutTrailingBlankLines(contentLines);
      this.previewHidesLines = streamed.length > THINKING_PREVIEW_LINES;
      const visibleLines =
        !this.expanded && this.previewHidesLines
          ? streamed.slice(streamed.length - THINKING_PREVIEW_LINES)
          : streamed;
      this.liveTitle = this.buildLiveTitle();
      rendered = [
        '',
        this.headerButton.render(width)[0] ?? '',
        ...visibleLines.map((line) => MESSAGE_INDENT + line),
      ];
    } else if (this.finishedForm.kind === 'opened') {
      this.previewHidesLines = false;
      rendered = [
        '',
        openedTitle(this.finishedForm.title, width),
        ...withoutTrailingBlankLines(contentLines).map((line) => MESSAGE_INDENT + line),
      ];
    } else {
      this.previewHidesLines = contentLines.length > THINKING_PREVIEW_LINES + FINALIZED_FOLD_HINT_ROWS;
      const lines: string[] = [''];
      for (let i = 0; i < contentLines.length; i++) {
        const p =
          i === 0 && this.showMarker ? currentTheme.fg('textDim', STATUS_BULLET) : MESSAGE_INDENT;
        lines.push(p + contentLines[i]);
      }

      if (this.expanded || contentLines.length <= THINKING_PREVIEW_LINES + FINALIZED_FOLD_HINT_ROWS) {
        rendered = lines;
      } else {
        // Leading blank + first PREVIEW_LINES content lines + hint line.
        const truncated = lines.slice(0, 1 + THINKING_PREVIEW_LINES);
        const remaining = contentLines.length - THINKING_PREVIEW_LINES;
        const hint = t('tui.messages.thinking.expandHint', { count: remaining });
        const indentWidth = Math.min(MESSAGE_INDENT.length, Math.max(0, width));
        const hintWidth = Math.max(0, width - indentWidth);
        truncated.push(
          ' '.repeat(indentWidth) + currentTheme.dim(truncateToWidth(hint, hintWidth, '…')),
        );
        rendered = truncated;
      }
    }

    if (isRenderCacheEnabled()) {
      this.renderCache = { width, lines: rendered };
    }
    return rendered;
  }

  renderRowDetail(width: number): string[] {
    if (isRenderCacheEnabled() && this.rowDetailCache?.width === width) {
      return this.rowDetailCache.lines;
    }
    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.text.length > 0 ? this.textComponent.render(contentWidth) : [''];
    const lines = withoutTrailingBlankLines(contentLines).map((line) => MESSAGE_INDENT + line);
    this.rowDetailCache = { width, lines };
    return lines;
  }

  private buildLiveTitle(): string {
    const paint = this.sweep.painter();
    const label = t('tui.messages.thinking.liveTitle');
    return (
      paint(STATUS_BULLET, 0) +
      paint(label, visibleWidth(STATUS_BULLET)) +
      elapsedSuffix(this.startedAtMs, Date.now())
    );
  }

  private startFrames(): void {
    if (this.ui === undefined || this.frameRequest !== undefined) return;
    this.sweep.start(performance.now());
    this.frameRequest = this.ui.requestAnimationFrame(this.onFrame);
  }

  private readonly onFrame = (time: number): void => {
    this.sweep.advance(time, visibleWidth(STATUS_BULLET) + visibleWidth(t('tui.messages.thinking.liveTitle')), true);
    const shown = `${this.sweep.frameKey}|${String(shownSeconds(this.startedAtMs, Date.now()))}`;
    if (shown !== this.shownAnimation) {
      this.shownAnimation = shown;
      this.markRenderDirty();
      this.ui?.requestRender();
    }
    this.frameRequest = this.ui?.requestAnimationFrame(this.onFrame);
  };

  private stopFrames(): void {
    if (this.frameRequest === undefined) return;
    this.ui?.cancelAnimationFrame(this.frameRequest);
    this.frameRequest = undefined;
  }
}

function sameFinishedForm(left: FinishedThinkingForm, right: FinishedThinkingForm): boolean {
  if (left.kind === 'standalone' || right.kind === 'standalone') return left.kind === right.kind;
  return left.title === right.title;
}

function openedTitle(title: string, width: number): string {
  const dim = (text: string): string => currentTheme.fg('textDim', text);
  return renderHeaderContent({
    head: '  ',
    flex: { text: title, style: dim, keep: 'head' },
    tail: '',
  }, width);
}

function withoutTrailingBlankLines(lines: readonly string[]): readonly string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').replaceAll(ANSI_ESCAPE_PATTERN, '').trim() === '') end--;
  return lines.slice(0, end);
}
