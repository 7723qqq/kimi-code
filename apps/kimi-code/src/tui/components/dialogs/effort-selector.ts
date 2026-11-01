import type { ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { currentTheme } from '#/tui/theme';
import { listMouseDispatch, regionAt, type ListRowRegion } from '#/tui/utils/list-mouse';
import { isSettlingClick } from '#/tui/utils/terminal-focus';

import { effortLabel } from './model-selector';

export interface EffortSelectorOptions {
  readonly title?: string;
  /** Selectable thinking efforts for the current model (e.g. ["off","low","high","max"]). */
  readonly efforts: readonly ThinkingEffort[];
  /** Currently active effort (highlighted). */
  readonly currentValue: ThinkingEffort;
  readonly onSelect: (effort: ThinkingEffort) => void;
  /** When provided, Alt+S applies the choice to the current session only. */
  readonly onSessionOnlySelect?: (effort: ThinkingEffort) => void;
  readonly onCancel: () => void;
  /** When set, rendered as warning-colored lines directly below the key-hint
   * line; wraps instead of truncating when it exceeds the width (e.g. the
   * mid-conversation switch cost notice). */
  readonly warning?: string;
}

/**
 * Horizontal segmented picker for the `/effort` command.
 *
 * Mirrors the thinking control rendered under `/model` (see
 * `renderThinkingControl` in model-selector.ts): a single row of segments,
 * the active one wrapped in `[ ]`. ←/→ step the active segment, Enter
 * commits, and Alt+S (when provided) applies session-only.
 */
export class EffortSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: EffortSelectorOptions;
  private activeIndex: number;
  /** Columns each segment occupied in the last render, for pointer hits. */
  private readonly segmentRegions: ListRowRegion[] = [];
  private readonly shownAt = Date.now();

  constructor(opts: EffortSelectorOptions) {
    super();
    this.opts = opts;
    const idx = opts.efforts.indexOf(opts.currentValue);
    this.activeIndex = Math.max(idx, 0);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.activeIndex = Math.max(0, this.activeIndex - 1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.activeIndex = Math.min(this.opts.efforts.length - 1, this.activeIndex + 1);
      return;
    }
    if (matchesKey(data, Key.alt('s')) && this.opts.onSessionOnlySelect !== undefined) {
      this.opts.onSessionOnlySelect(this.opts.efforts[this.activeIndex]!);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.opts.onSelect(this.opts.efforts[this.activeIndex]!);
      return;
    }
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    return listMouseDispatch(this, event, this.mouseEvent(event));
  }

  private mouseEvent(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.focused) {
      if (event.type === 'press') return { handled: true };
      if (event.type === 'click') return { handled: true, focus: true };
      return undefined;
    }

    if (event.type === 'wheel') {
      if (event.wheelDelta === undefined) return { handled: true };
      const delta = event.wheelDelta < 0 ? -1 : 1;
      const next = Math.max(0, Math.min(this.opts.efforts.length - 1, this.activeIndex + delta));
      if (next === this.activeIndex) return { handled: true };
      this.activeIndex = next;
      return { handled: true, render: true };
    }

    if (event.type !== 'press' && event.type !== 'click') return undefined;
    const segment = regionAt(this.segmentRegions, event);
    if (segment === undefined) return undefined;

    this.activeIndex = segment.index;
    if (event.type === 'click' && !isSettlingClick(this.shownAt)) {
      this.opts.onSelect(this.opts.efforts[segment.index]!);
    }
    return { handled: true, render: true };
  }

  override render(width: number): string[] {
    const hintParts = [
      t('tui.dialogs.effortSelector.hintSwitch'),
      t('tui.dialogs.effortSelector.hintSelect'),
    ];
    if (this.opts.onSessionOnlySelect !== undefined)
      hintParts.push(t('tui.dialogs.effortSelector.hintSessionOnly'));
    hintParts.push(t('tui.dialogs.effortSelector.hintCancel'));

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg(
        'primary',
        ` ${this.opts.title ?? t('tui.dialogs.effortSelector.title')}`,
      ),
      currentTheme.fg('textMuted', ` ${hintParts.join(' · ')}`),
    ];
    if (this.opts.warning !== undefined) {
      for (const line of wrapTextWithAnsi(this.opts.warning, Math.max(1, width - 1))) {
        lines.push(currentTheme.fg('warning', ` ${line}`));
      }
    }
    lines.push('');

    const segments = this.opts.efforts.map((effort, index) => {
      const label = effortLabel(effort);
      return index === this.activeIndex
        ? currentTheme.boldFg('primary', `[ ${label} ]`)
        : currentTheme.fg('text', `  ${label}  `);
    });
    const row = lines.length;
    this.segmentRegions.length = 0;
    let column = 2;
    for (let i = 0; i < segments.length; i++) {
      const segmentWidth = visibleWidth(segments[i]!);
      this.segmentRegions.push({
        start: row,
        end: row + 1,
        columnStart: column,
        columnEnd: column + segmentWidth,
        index: i,
      });
      column += segmentWidth + 2;
    }
    lines.push(`  ${segments.join('  ')}`);

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
