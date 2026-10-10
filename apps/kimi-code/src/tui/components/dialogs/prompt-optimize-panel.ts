/**
 * PromptOptimizePanel — shows the model's rewrite of the drafted prompt
 * against the original and asks the user to accept or discard it.
 *
 * Mirrors the container-replacement pattern: the host mounts it over the
 * editor, the user picks accept/discard, and the host tears it down and
 * applies the accepted text back into the editor.
 */

import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

export type PromptOptimizeChoice = 'accept' | 'discard';

export interface PromptOptimizePanelOptions {
  readonly original: string;
  readonly optimized: string;
  readonly onSelect: (choice: PromptOptimizeChoice) => void;
  /**
   * Rows the scrollable diff region may occupy. The panel is mounted in place of
   * the editor and is never handed the terminal height, so the host passes the
   * budget it can afford; the fallback keeps the panel usable when it does not.
   */
  readonly maxVisible?: number;
}

const MAX_DIFF_LINES = 24;
const MAX_EXPANDED_DIFF_LINES = 200;
/**
 * Ceiling on rendered rows after wrapping. A single long line can expand into
 * hundreds once folded, which would push the accept/discard choices off screen;
 * the cap keeps them reachable and is reported rather than silently applied.
 */
const MAX_WRAPPED_LINES = 400;

/** Default rows for the diff region when the host grants no explicit budget. */
const DEFAULT_MAX_VISIBLE = 20;

/** Rows a page key moves, derived from the same budget the region renders with. */
function pageStep(rows: number): number {
  return Math.max(1, rows - 1);
}

/**
 * Visible columns the diff gutter occupies: a 4-wide line number, a space, and
 * the 2-char `+ `/`- `/`  ` marker. Continuation rows align under the code so a
 * wrapped line still reads as one entry.
 */
const DIFF_HANG_INDENT = 7;

/**
 * Fold a rendered row to `width`, indenting continuation rows to `indent`.
 *
 * The row arrives as a single ANSI string with the gutter and the coloured code
 * already concatenated, so the fold happens in two passes: wrap at the full
 * width to find the break points, then re-wrap each continuation under the
 * narrower budget left by the indent. `wrapTextWithAnsi` carries active SGR
 * codes across the breaks it introduces, so colour survives both passes.
 */
export function wrapRenderedRow(row: string, width: number, indent: number): string[] {
  if (width <= 0) return [''];
  if (visibleWidth(row) <= width) return [row];
  const first = wrapTextWithAnsi(row, width);
  if (first.length <= 1) return first;
  const pad = ' '.repeat(Math.max(0, Math.min(indent, width - 1)));
  const budget = Math.max(1, width - pad.length);
  const out: string[] = [first[0] ?? ''];
  for (let i = 1; i < first.length; i++) {
    for (const piece of wrapTextWithAnsi(first[i] ?? '', budget)) {
      out.push(pad + piece);
    }
  }
  return out;
}

/**
 * Columns a rendered diff row reserves before its code begins.
 *
 * Measured from the row's own shape rather than hard-coded, because the panel
 * also renders separators whose indent differs from the numbered rows.
 */
export function hangIndentFor(row: string): number {
  const plain = stripAnsiCodes(row);
  // `   1 + code` / `  12 - code`: line number, space, marker.
  if (/^\s*\d+\s[+\- ]/.test(plain)) return DIFF_HANG_INDENT;
  // `     … 3 unchanged lines …`: a labelled separator, aligned with its text.
  return /^ */.exec(plain)?.[0].length ?? 0;
}

/**
 * Visible text with SGR escape sequences removed.
 *
 * `visibleWidth` measures the same string, so the two agree on what a column is
 * while the regex only has to recognise the row's shape.
 */
function stripAnsiCodes(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

export class PromptOptimizePanelComponent implements Component, Focusable {
  focused = false;

  private readonly opts: PromptOptimizePanelOptions;
  private selected: PromptOptimizeChoice = 'accept';
  private expanded = false;
  /** Index of the topmost visible diff row. */
  private scrollTop = 0;
  /** Row count of the last render, used by the page keys. */
  private lastDiffRowCount = 0;

  constructor(opts: PromptOptimizePanelOptions) {
    this.opts = opts;
  }

  private get visibleRows(): number {
    return Math.max(1, this.opts.maxVisible ?? DEFAULT_MAX_VISIBLE);
  }

  private scrollTo(target: number): void {
    const max = Math.max(0, this.lastDiffRowCount - this.visibleRows);
    this.scrollTop = Math.max(0, Math.min(target, max));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onSelect('discard');
      return;
    }
    if (matchesKey(data, Key.ctrl('o'))) {
      this.expanded = !this.expanded;
      // The content length changes under the window, so the clamp has to run
      // against the new length rather than leaving the window past the end.
      this.scrollTop = 0;
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollTo(this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollTo(this.scrollTop + 1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTo(this.scrollTop - pageStep(this.visibleRows));
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTo(this.scrollTop + pageStep(this.visibleRows));
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.scrollTo(0);
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.scrollTo(Number.MAX_SAFE_INTEGER);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.selected = 'accept';
      return;
    }
    if (matchesKey(data, Key.right)) {
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

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'wheel') return undefined;
    // Direction comes only from `wheelDelta` (the button field has no wheel
    // value); a positive delta scrolls toward later rows.
    const delta = event.wheelDelta ?? 0;
    if (delta === 0) return undefined;
    this.scrollTo(this.scrollTop + delta);
    // Always consume: letting the transcript take over mid-read would scroll the
    // conversation out from under the panel the pointer is resting on.
    return { handled: true };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = currentTheme;
    const lines: string[] = [
      theme.fg('primary', '─'.repeat(Math.max(1, width))),
      truncateToWidth(theme.boldFg('primary', t('tui.dialogs.promptOptimize.title')), width),
      // The hint is a fixed string in both locales, so at a narrow terminal it
      // has to be clamped like every other row rather than overflowing.
      truncateToWidth(
        theme.fg(
          'textMuted',
          t('tui.dialogs.promptOptimize.hint', { accept: 'Enter', discard: 'Esc' }),
        ),
        width,
      ),
      truncateToWidth(
        theme.fg(
          'textMuted',
          t('tui.dialogs.promptOptimize.scrollHint', { expand: 'Ctrl+O' }),
        ),
        width,
      ),
      '',
    ];
    const diffRows: string[] = [];
    let wrapTruncated = false;
    for (const row of renderDiffLinesClustered(this.opts.original, this.opts.optimized, '', {
      contextLines: 2,
      maxLines: this.expanded ? MAX_EXPANDED_DIFF_LINES : MAX_DIFF_LINES,
      expandKeyHint: this.expanded ? 'ctrl+o' : undefined,
    })) {
      const wrapped = wrapRenderedRow(row, width, hangIndentFor(row));
      if (diffRows.length + wrapped.length > MAX_WRAPPED_LINES) {
        const room = MAX_WRAPPED_LINES - diffRows.length;
        if (room > 0) diffRows.push(...wrapped.slice(0, room));
        wrapTruncated = true;
        break;
      }
      diffRows.push(...wrapped);
    }
    this.lastDiffRowCount = diffRows.length;

    const visible = this.visibleRows;
    if (diffRows.length > visible) {
      this.scrollTo(this.scrollTop);
      const slice = diffRows.slice(this.scrollTop, this.scrollTop + visible);
      lines.push(...slice);
      const from = this.scrollTop + 1;
      const to = this.scrollTop + slice.length;
      lines.push(
        truncateToWidth(
          theme.fg(
            'textMuted',
            `   … ${t('tui.dialogs.promptOptimize.showing', {
              from,
              to,
              total: diffRows.length,
            })}`,
          ),
          width,
        ),
      );
    } else {
      this.scrollTop = 0;
      lines.push(...diffRows);
    }

    if (wrapTruncated) {
      lines.push(
        theme.fg(
          'textMuted',
          truncateToWidth(`     … ${t('tui.diffPreview.wrappedRowsTruncated')}`, width),
        ),
      );
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
