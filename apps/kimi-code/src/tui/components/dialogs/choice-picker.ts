/**
 * ChoicePicker — modal single-select list for slash commands that ask
 * the user to pick from a small set of preset values.
 *
 * Mirrors SessionPickerComponent's container-replacement pattern: host
 * calls `showChoicePicker(...)` which clears the editor container,
 * addChild(picker), setFocus(picker); the picker invokes `onSelect` or
 * `onCancel`, and the host tears it down.
 */

import {
  matchesKey,
  Key,
  truncateToWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { DockSection, type DockLayout, type DockPart } from '#/tui/components/chrome/dock-section';
import { Markdown } from '#/tui/components/markdown/markdown';
import { getCurrentMark, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';
import { ListMouseRouter, type ListRowRegion, searchableListCursor } from '#/tui/utils/mouse';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';
import { wrapText as wrapDescription } from '#/tui/utils/wrap-text';

export interface ChoiceOption {
  /** Value passed to onSelect (e.g. the actual editor command string). */
  readonly value: string;
  /** Display text shown in the list. */
  readonly label: string;
  /** Optional semantic tone for labels that need stronger visual treatment. */
  readonly tone?: 'danger';
  /** Optional explanatory text shown below the label. */
  readonly description?: string | undefined;
  /** Color token applied to the description while this option is selected, drawing
   *  attention to important details. Falls back to `textMuted` when unset or not selected. */
  readonly descriptionTone?: ColorToken;
}

export interface ChoicePickerOptions {
  readonly title: string;
  readonly hint?: string;
  readonly formatHint?: (text: string) => string;
  /** Plain text shown in `noticeTone`, or Markdown rendered with the Markdown theme. */
  readonly notice?: string | { readonly markdown: string };
  /** Color tone for a plain-text notice. Defaults to 'success'. */
  readonly noticeTone?: 'success' | 'warning';
  readonly options: readonly ChoiceOption[];
  readonly currentValue?: string;
  readonly initialValue?: string;
  /** When true, typed characters filter the list (fuzzy) and a search line is shown. */
  readonly searchable?: boolean;
  readonly spaceSelect?: boolean;
  /** Items per page. Lists longer than this paginate. */
  readonly pageSize?: number;
  readonly onSelect: (value: string) => void;
  /** When provided, Alt+S invokes this with the selected value instead of
   * onSelect — used to apply the choice to the current session only. */
  readonly onSessionOnlySelect?: (value: string) => void;
  readonly onCancel: () => void;
}

export class ChoicePickerComponent implements Component, Focusable {
  focused = false;
  // The picker pages its own list with PageUp/PageDown; in the alternate screen
  // that key would otherwise scroll the transcript behind it.
  readonly ownsViewportKeys = true;
  private readonly opts: ChoicePickerOptions;
  private readonly list: SearchableList<ChoiceOption>;
  private readonly mouse: ListMouseRouter<ChoiceOption>;

  constructor(opts: ChoicePickerOptions) {
    this.opts = opts;
    const initialIdx = opts.options.findIndex(
      (o) => o.value === (opts.initialValue ?? opts.currentValue),
    );
    this.list = new SearchableList({
      items: opts.options,
      toSearchText: (o) => `${o.label} ${o.description ?? ''}`,
      pageSize: opts.pageSize,
      initialIndex: Math.max(initialIdx, 0),
      searchable: opts.searchable === true,
    });
    this.mouse = new ListMouseRouter(
      searchableListCursor(() => this.list),
      (option) => this.opts.onSelect(option.value),
      { isFocused: () => this.focused },
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.alt('s')) && this.opts.onSessionOnlySelect !== undefined) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSessionOnlySelect(chosen.value);
      return;
    }
    // Left/Right page through the list (this picker has no horizontal control).
    if (matchesKey(data, Key.left)) {
      this.list.pageUp();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.list.pageDown();
      return;
    }
    // Space confirmation is opt-out; searchable lists always route it to the query.
    const isSpace = matchesKey(data, Key.space) || printableChar(data) === ' ';
    if (
      matchesKey(data, Key.enter) ||
      (isSpace && this.opts.searchable !== true && this.opts.spaceSelect !== false)
    ) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSelect(chosen.value);
      return;
    }
    this.list.handleKey(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.mouse.handleMouse(event);
  }

  invalidate(): void {}

  selectedValue(): string | undefined {
    return this.list.selected()?.value;
  }

  render(width: number): string[] {
    return [...this.renderHead(width), ...this.renderFoot(width)];
  }

  renderHead(width: number, hintSuffix = ''): string[] {
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const options = view.items;

    // Header mirrors the model dialog (see model-selector.ts): border, title
    // with a "(type to search)" suffix until you type, the hint, a blank, then
    // the search line. Key vocabulary is lowercase to match every list dialog.
    const hint = (this.opts.hint ?? t('tui.dialogs.choicePicker.navHint')) + hintSuffix;

    const titleSuffix =
      searchable && view.query.length === 0
        ? currentTheme.fg('textMuted', `  (${t('tui.dialogs.choicePicker.searchHint')})`)
        : '';
    const hintLines = hint.split(/\r?\n/);
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${this.opts.title}`) + titleSuffix,
    ];
    for (const hintLine of hintLines) {
      lines.push(
        this.opts.formatHint === undefined
          ? currentTheme.fg('textMuted', ` ${hintLine}`)
          : this.opts.formatHint(` ${hintLine}`),
      );
    }
    const notice = this.opts.notice;
    if (typeof notice === 'object') {
      const markdown = new Markdown(
        notice.markdown,
        0,
        0,
        createMarkdownTheme(),
        undefined,
        createMarkdownOptions(),
      );
      lines.push('');
      lines.push(...markdown.render(Math.max(1, width - 1)).map((line) => ` ${line}`));
    } else if (notice !== undefined) {
      const tone = this.opts.noticeTone ?? 'success';
      const noticeWidth = Math.max(1, width - 1);
      lines.push('');
      for (const noticeLine of notice.split(/\r?\n/)) {
        for (const wrapped of wrapDescription(noticeLine, noticeWidth)) {
          lines.push(currentTheme.fg(tone, ` ${wrapped}`));
        }
      }
    }
    lines.push('');
    if (searchable && view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ` Search: `) + currentTheme.fg('text', view.query));
    }

    if (options.length === 0) {
      lines.push(currentTheme.fg('textMuted', `   ${t('tui.dialogs.choicePicker.noMatches')}`));
    }
    const choiceRegions: ListRowRegion[] = [];
    for (let i = view.page.start; i < view.page.end; i++) {
      const start = lines.length;
      const opt = options[i]!;
      const isSelected = i === view.selectedIndex;
      const isCurrent = opt.value === this.opts.currentValue;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const labelStyle = optionLabelStyle(opt, isSelected);
      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      line += labelStyle(opt.label);
      if (isCurrent) {
        line += ' ' + currentTheme.fg('success', getCurrentMark());
      }
      lines.push(line);
      if (opt.description !== undefined && opt.description.length > 0) {
        const descriptionWidth = Math.max(1, width - 4);
        const descriptionColor =
          isSelected && opt.descriptionTone !== undefined ? opt.descriptionTone : 'textMuted';
        for (const descLine of wrapDescription(opt.description, descriptionWidth)) {
          lines.push(currentTheme.fg(descriptionColor, `    ${descLine}`));
        }
      }
      choiceRegions.push({ start, end: lines.length, index: i });
    }
    this.mouse.setRegions(choiceRegions);

    lines.push('');
    return this.finishLines(lines, width);
  }

  renderFoot(width: number): string[] {
    const { page } = this.list.view();
    const lines: string[] = [];
    if (page.pageCount > 1) {
      lines.push(
        currentTheme.fg(
          'textMuted',
          ` ${t('tui.dialogs.choicePicker.page', { page: page.page + 1, pageCount: page.pageCount })}`,
        ),
      );
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return this.finishLines(lines, width);
  }

  private finishLines(lines: readonly string[], width: number): string[] {
    const rendered = lines.map((line) => truncateToWidth(line, width));
    return this.focused ? rendered : rendered.map((line) => currentTheme.fade(line));
  }
}

export interface ChoicePreview {
  render(value: string, width: number): readonly string[];
  invalidate(): void;
  dispose(): void;
}

export interface PreviewChoicePickerOptions extends ChoicePickerOptions {
  readonly preview: ChoicePreview;
  readonly layout?: DockLayout;
}

const PREVIEW_LABEL = ` ${t('tui.dialogs.choicePicker.previewLabel')}`;

export class PreviewChoicePickerComponent extends DockSection implements Focusable {
  private readonly picker: ChoicePickerComponent;

  constructor(private readonly opts: PreviewChoicePickerOptions) {
    super(opts.layout);
    this.picker = new ChoicePickerComponent(opts);
  }

  get focused(): boolean {
    return this.picker.focused;
  }

  set focused(focused: boolean) {
    this.picker.focused = focused;
  }

  handleInput(data: string): void {
    if (this.layout !== undefined && (matchesKey(data, 'shift+up') || matchesKey(data, 'shift+down'))) {
      this.scrollBody(matchesKey(data, 'shift+up') ? -1 : 1);
      return;
    }
    this.showingNewChoiceFromTop(() => {
      this.picker.handleInput(data);
    });
  }

  override invalidate(): void {
    super.invalidate();
    this.opts.preview.invalidate();
  }

  dispose(): void {
    this.opts.preview.dispose();
  }

  protected renderPart(part: DockPart, width: number): string[] {
    switch (part) {
      case 'head':
        return [
          ...this.picker.renderHead(
            width,
            this.bodyOverflows(width) ? t('tui.dialogs.choicePicker.scrollHint') : '',
          ),
          ...this.finishLines(
            [PREVIEW_LABEL, ''].map((line) => currentTheme.fg('textMuted', line)),
            width,
          ),
        ];
      case 'body':
        return this.finishLines(this.previewLines(width), width);
      case 'foot':
        return this.picker.renderFoot(width);
    }
  }

  protected override handlePartMouse(part: DockPart, event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'wheel' && part === 'body') return undefined;
    if (event.type === 'wheel' || part === 'head') {
      return this.showingNewChoiceFromTop(() => this.picker.handleMouse(event));
    }
    if (this.focused) return undefined;
    if (event.type === 'press') return { handled: true };
    if (event.type === 'click') return { handled: true, focus: true };
    return undefined;
  }

  private showingNewChoiceFromTop<T>(action: () => T): T {
    const shown = this.picker.selectedValue();
    const result = action();
    if (this.picker.selectedValue() !== shown) this.scrollBodyToTop();
    return result;
  }

  private previewLines(width: number): string[] {
    const { preview, options } = this.opts;
    const tallestRows = Math.max(0, ...options.map((option) => preview.render(option.value, width).length));
    const value = this.picker.selectedValue();
    const shown = value === undefined ? [] : preview.render(value, width);
    return [...shown, ...Array.from({ length: tallestRows - shown.length }, () => ''), ''];
  }

  private finishLines(lines: readonly string[], width: number): string[] {
    const finished = lines.map((line) => truncateToWidth(line, width));
    return this.focused ? finished : finished.map((line) => currentTheme.fade(line));
  }
}

function optionLabelStyle(option: ChoiceOption, selected: boolean): (text: string) => string {
  if (option.tone === 'danger') {
    return selected
      ? (text) => currentTheme.boldFg('error', text)
      : (text) => currentTheme.fg('error', text);
  }
  return selected
    ? (text) => currentTheme.boldFg('primary', text)
    : (text) => currentTheme.fg('text', text);
}
