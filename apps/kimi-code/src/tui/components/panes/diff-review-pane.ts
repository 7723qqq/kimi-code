/**
 * DiffReviewPaneComponent — opencode-style file-change review panel.
 *
 * Lists every file changed by the session's tool calls (from the tool-call
 * `display` data), with per-file add/remove counts. `↑`/`↓` (or `j`/`k`)
 * move the selection, `Enter`/`→` opens the selected file's diff, `←`/`Esc`
 * returns to the list. The host aggregates the items from the transcript
 * (`updateDiffReviewPane`) and pushes them via `setItems`.
 */

import { Container, Key, decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { renderDiffLines } from '#/tui/components/media/diff-preview';
import { currentTheme } from '#/tui/theme';

export interface DiffReviewItem {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

const PANE_TITLE = 'Review';
const LIST_INDENT = '  ';
const MAX_DIFF_LINES = 200;

export class DiffReviewPaneComponent extends Container {
  private items: DiffReviewItem[] = [];
  private selectedIndex = 0;
  private viewMode: 'list' | 'detail' = 'list';
  private scrollTop = 0;

  setItems(items: DiffReviewItem[]): void {
    this.items = items;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));
    if (this.viewMode === 'detail' && this.selectedItem() === undefined) {
      this.viewMode = 'list';
    }
  }

  getItems(): readonly DiffReviewItem[] {
    return this.items;
  }

  /** Handle a key while the pane is focused. Returns true when consumed. */
  handleKey(data: string): boolean {
    if (matchesKey(data, Key.escape)) {
      if (this.viewMode === 'detail') {
        this.viewMode = 'list';
        return true;
      }
      return false; // host closes the pane
    }
    if (this.viewMode === 'detail') {
      if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace)) {
        this.viewMode = 'list';
        return true;
      }
      if (matchesKey(data, Key.up)) {
        this.scrollTop = Math.max(0, this.scrollTop - 1);
        return true;
      }
      if (matchesKey(data, Key.down)) {
        this.scrollTop += 1;
        return true;
      }
      return false;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
      if (this.selectedItem() !== undefined) {
        this.viewMode = 'detail';
        this.scrollTop = 0;
      }
      return true;
    }
    if (matchesKey(data, Key.up)) {
      this.move(-1);
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.move(1);
      return true;
    }
    const printable = decodeKittyPrintable(data) ?? data;
    if (printable === 'j') {
      this.move(1);
      return true;
    }
    if (printable === 'k') {
      this.move(-1);
      return true;
    }
    return false;
  }

  private move(delta: number): void {
    if (this.items.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
  }

  private selectedItem(): DiffReviewItem | undefined {
    return this.items[this.selectedIndex];
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const border = currentTheme.fg('border', '─'.repeat(safeWidth));
    const lines: string[] = [border, currentTheme.boldFg('primary', ` ${PANE_TITLE}`), border];

    if (this.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', `  ${t('tui.panes.diffReviewPane.empty')}`), border);
      return lines;
    }

    if (this.viewMode === 'detail') {
      lines.push(...this.renderDetail(safeWidth));
    } else {
      lines.push(...this.renderList(safeWidth));
    }
    lines.push(border);
    return lines;
  }

  private renderList(width: number): string[] {
    const lines: string[] = [];
    for (const [i, item] of this.items.entries()) {
      const selected = i === this.selectedIndex;
      const pointer = selected ? '❯' : ' ';
      const stats = diffStats(item);
      const labelWidth = Math.max(1, width - visibleWidth(LIST_INDENT) - 2 - visibleWidth(stats));
      const label = truncateToWidth(item.path, labelWidth, '…');
      const line = `${LIST_INDENT}${pointer} ${label} ${stats}`;
      lines.push(
        selected
          ? currentTheme.bg('accent', currentTheme.fg('text', line))
          : currentTheme.fg('text', line),
      );
    }
    return lines;
  }

  private renderDetail(width: number): string[] {
    const item = this.selectedItem();
    if (item === undefined) return [];
    const diffLines = renderDiffLines(item.before, item.after, item.path, false, undefined, undefined, MAX_DIFF_LINES);
    const maxVisible = Math.max(5, width > 0 ? 40 : 5);
    if (diffLines.length > maxVisible) {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, diffLines.length - maxVisible));
      const slice = diffLines.slice(this.scrollTop, this.scrollTop + maxVisible);
      const from = this.scrollTop + 1;
      const to = this.scrollTop + slice.length;
      const scrollInfo = currentTheme.fg(
        'textMuted',
        t('tui.dialogs.helpPanel.showing', { from, to, total: diffLines.length }),
      );
      return [...slice, scrollInfo];
    }
    this.scrollTop = 0;
    return diffLines;
  }
}

function diffStats(item: DiffReviewItem): string {
  const added = countKind(item.before, item.after, 'add');
  const removed = countKind(item.before, item.after, 'delete');
  const parts: string[] = [];
  if (added > 0) parts.push(currentTheme.fg('diffAdded', `+${added}`));
  if (removed > 0) parts.push(currentTheme.fg('diffRemoved', `-${removed}`));
  return parts.join(' ');
}

function countKind(before: string, after: string, kind: 'add' | 'delete'): number {
  const beforeLines = before ? before.split('\n') : [];
  const afterLines = after ? after.split('\n') : [];
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  if (kind === 'add') {
    return afterLines.filter((l) => !beforeSet.has(l)).length;
  }
  return beforeLines.filter((l) => !afterSet.has(l)).length;
}
