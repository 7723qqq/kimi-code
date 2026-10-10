/**
 * TodoPanel — live-updating TODO list shown before the input area.
 *
 * Mounted as a dedicated `Container` slot between the activity pane
 * (spinners / thinking stream) and the queue / editor block. The host
 * calls {@link setTodos} whenever the LLM invokes the `TodoList`
 * tool; state survives across turns so the list stays visible until
 * explicitly cleared (`todos: []`), a new session starts, or `/clear`
 * is issued.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { t } from '#/i18n';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import { renderBrailleBar, renderStatusBar } from '#/tui/utils/progress-bar';

export type TodoStatus = 'pending' | 'in_progress' | 'done';
export type TodoKind = 'milestone' | 'task';

export interface TodoItem {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly kind?: TodoKind;
  readonly title: string;
  readonly status: TodoStatus;
  readonly progress?: number;
}

export type PanelTodoItem = TodoItem;

export interface TodoProgressReport {
  readonly overall: number;
  readonly done: number;
  readonly total: number;
  readonly byId: ReadonlyMap<string, number>;
}

export interface TodoNode {
  readonly item: TodoItem;
  readonly children: readonly TodoNode[];
}

const MAX_VISIBLE = 5;
const MAX_ACTIVE_CHILD_ROWS = 4;
/**
 * Rows the expanded list may occupy before it scrolls. Expanded means "let me
 * see the whole plan", not "take the screen": with 60 todos the panel used to
 * render 63 lines on a 24-row terminal and pushed the editor away, the same
 * failure the Updates box had.
 */
const EXPANDED_MAX_ROWS = 16;
/** Rows spent before any todo: the separator, the header, and the hint line. */
const PANEL_OVERHEAD_ROWS = 3;
const BRAILLE_BAR_WIDTH = 5;
const STATUS_BAR_WIDTH = 10;

export function buildTodoTree(todos: readonly TodoItem[]): readonly TodoNode[] {
  const keyOf = (item: TodoItem): string => item.id ?? item.title;
  const known = new Set(todos.map(keyOf));
  const childrenOf = new Map<string, TodoItem[]>();
  const topLevel: TodoItem[] = [];
  for (const item of todos) {
    const parentKey = item.parentId ?? null;
    if (parentKey !== null && known.has(parentKey) && parentKey !== keyOf(item)) {
      const list = childrenOf.get(parentKey) ?? [];
      list.push(item);
      childrenOf.set(parentKey, list);
    } else {
      topLevel.push(item);
    }
  }
  const build = (item: TodoItem): TodoNode => ({
    item,
    children: (childrenOf.get(keyOf(item)) ?? []).map(build),
  });
  return topLevel.map(build);
}

export function computePanelProgress(todos: readonly TodoItem[]): TodoProgressReport {
  if (todos.length === 0) {
    return { overall: 0, done: 0, total: 0, byId: new Map() };
  }
  const keyOf = (item: TodoItem): string => item.id ?? item.title;
  const childrenOf = new Map<string, TodoItem[]>();
  for (const item of todos) {
    if (item.parentId === null || item.parentId === undefined) continue;
    const list = childrenOf.get(item.parentId) ?? [];
    list.push(item);
    childrenOf.set(item.parentId, list);
  }
  const byId = new Map<string, number>();
  for (const item of todos) {
    if (item.kind === 'milestone') continue;
    byId.set(keyOf(item), leafProgress(item));
  }
  const milestones = todos.filter((item) => item.kind === 'milestone');
  if (milestones.length === 0) {
    const values = todos.map((item) => byId.get(keyOf(item)) ?? 0);
    return {
      overall: mean(values),
      done: todos.filter((item) => item.status === 'done').length,
      total: todos.length,
      byId,
    };
  }
  const milestoneValues: number[] = [];
  for (const milestone of milestones) {
    const children = childrenOf.get(keyOf(milestone)) ?? [];
    const value =
      children.length === 0
        ? leafProgress(milestone)
        : mean(children.map((child) => byId.get(keyOf(child)) ?? 0));
    byId.set(keyOf(milestone), value);
    milestoneValues.push(value);
  }
  const done = todos.filter((item) =>
    item.kind === 'milestone' ? (byId.get(keyOf(item)) ?? 0) >= 100 : item.status === 'done',
  ).length;
  return { overall: mean(milestoneValues), done, total: todos.length, byId };
}

function leafProgress(item: TodoItem): number {
  if (item.status === 'done') return 100;
  if (item.status === 'in_progress') return item.progress ?? 0;
  return 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((acc, v) => acc + v, 0) / values.length);
}

function effectiveStatus(item: TodoItem, progress: number): TodoStatus {
  if (item.kind !== 'milestone') return item.status;
  if (progress >= 100) return 'done';
  if (progress > 0) return 'in_progress';
  return 'pending';
}

export interface VisibleTodos {
  readonly rows: readonly TodoItem[];
  readonly hidden: number;
  readonly hiddenCounts: Record<TodoStatus, number>;
}

/**
 * Pick which todos to render when the list exceeds {@link MAX_VISIBLE}.
 *
 * The selector is order-agnostic — the TodoList tool keeps whatever
 * order the model produced and does not group items by status, so an
 * interleaved sequence like `pending, done, pending, done, ...` is
 * possible and must still yield MAX_VISIBLE rows when enough exist.
 *
 * Strategy:
 * 1. Include every `in_progress` item (capped at MAX_VISIBLE).
 * 2. Fill remaining slots with "what's next" — the earliest `pending`
 *    items in their original positions — while reserving one slot for
 *    "what just finished" — the latest `done` item — when both kinds
 *    exist. If one side has too few candidates, the other expands.
 *
 * Items are returned in their original order.
 */
export function selectVisibleTodos(todos: readonly TodoItem[]): VisibleTodos {
  if (todos.length <= MAX_VISIBLE) {
    return {
      rows: [...todos],
      hidden: 0,
      hiddenCounts: { done: 0, in_progress: 0, pending: 0 },
    };
  }

  const inProgress: number[] = [];
  const pending: number[] = [];
  const done: number[] = [];
  for (const [i, todo] of todos.entries()) {
    if (todo.status === 'in_progress') inProgress.push(i);
    else if (todo.status === 'pending') pending.push(i);
    else done.push(i);
  }

  const picked = new Set<number>();
  for (const i of inProgress.slice(0, MAX_VISIBLE)) picked.add(i);

  if (picked.size < MAX_VISIBLE) {
    // Most recent done first; earliest pending first.
    const doneCandidates = done.toReversed();
    const pendingCandidates = pending;

    const remaining = MAX_VISIBLE - picked.size;
    let doneCount: number;
    let pendingCount: number;
    if (doneCandidates.length === 0) {
      doneCount = 0;
      pendingCount = Math.min(remaining, pendingCandidates.length);
    } else if (pendingCandidates.length === 0) {
      pendingCount = 0;
      doneCount = Math.min(remaining, doneCandidates.length);
    } else {
      doneCount = 1;
      pendingCount = Math.min(remaining - 1, pendingCandidates.length);
      if (pendingCount < remaining - 1) {
        doneCount = Math.min(doneCandidates.length, remaining - pendingCount);
      }
    }

    for (let i = 0; i < doneCount; i++) picked.add(doneCandidates[i] as number);
    for (let i = 0; i < pendingCount; i++) picked.add(pendingCandidates[i] as number);
  }

  const sortedIdx = [...picked].toSorted((a, b) => a - b);

  const hiddenCounts: Record<TodoStatus, number> = { done: 0, in_progress: 0, pending: 0 };
  for (const [i, todo] of todos.entries()) {
    if (!picked.has(i)) {
      hiddenCounts[todo.status] += 1;
    }
  }

  return {
    rows: sortedIdx.map((i) => todos[i] as TodoItem),
    hidden: todos.length - sortedIdx.length,
    hiddenCounts,
  };
}

export interface TodoPanelOptions {
  /** Terminal rows, so the expanded list can be held to a share of the screen. */
  readonly terminalRows?: () => number;
}

export class TodoPanelComponent implements Component {
  private todos: readonly TodoItem[] = [];
  private expanded = false;
  private readonly terminalRows: () => number;
  /** First visible row of the expanded list; `0` means the top. */
  private scrollTop = 0;

  constructor(options: TodoPanelOptions = {}) {
    this.terminalRows = options.terminalRows ?? (() => 0);
  }

  /**
   * Body rows the expanded list may draw.
   *
   * Derived from the terminal height, not from what the layout actually
   * allocated: a panel cannot see its own allocation. On a very short terminal
   * the allocator may therefore hand this row fewer lines than the budget asks
   * for, and the frame clips the difference. The guarantee that holds either way
   * is that the panel never *asks* for more than its share of the screen, and
   * that a task stays visible at every height.
   *
   * A collapsed panel keeps its historical fixed cap ({@link MAX_VISIBLE}) so its
   * shape does not change with the terminal. Expanded is where the list grows,
   * so that is the path the budget constrains.
   */
  private expandedBodyBudget(): number {
    const rows = this.terminalRows();
    const totalRows =
      !Number.isFinite(rows) || rows <= 0
        ? EXPANDED_MAX_ROWS
        : Math.max(4, Math.min(EXPANDED_MAX_ROWS, Math.floor(rows / 2)));
    // The separator and header are mandatory; the hint is not. When the budget
    // is too tight for both the hint and one task, the task wins — a plan the
    // user cannot see is worse than a missing "ctrl+t to collapse".
    const withHint = totalRows - PANEL_OVERHEAD_ROWS;
    return withHint >= 1 ? withHint : Math.max(0, totalRows - (PANEL_OVERHEAD_ROWS - 1));
  }

  /** True when the budget leaves no room for the hint below the tasks. */
  private hintBudgetedOut(): boolean {
    return this.expandedBodyBudget() === 0;
  }

  /**
   * Largest valid scroll offset for the expanded list; `0` while collapsed.
   *
   * This is `body rows - visible rows`, which is *not* the same as
   * {@link hiddenExpandedRows}: the hint line below the body is never scrolled
   * away, so the last `hiddenExpandedRows()` rows are partly unreachable. Using
   * the hidden-row count as the clamp let `scrollBy` report movement at the end
   * of the list while the view no longer changed.
   */
  private expandedMaxScroll(): number {
    if (!this.expanded) return 0;
    return Math.max(0, this.todos.length - this.expandedBodyBudget());
  }

  /** Expanded list rows currently out of view; `0` while collapsed. */
  hiddenExpandedRows(): number {
    return this.expandedMaxScroll();
  }

  /** Scroll the expanded list by `delta` rows; false when it cannot move. */
  scrollBy(delta: number): boolean {
    if (!this.expanded) return false;
    const max = this.expandedMaxScroll();
    const next = Math.max(0, Math.min(max, this.scrollTop + delta));
    if (next === this.scrollTop) return false;
    this.scrollTop = next;
    return true;
  }

  /**
   * The visible window of the expanded body. Scrolled rows replace the top so
   * the hint below still says how many entries exist and how to collapse.
   */
  private sliceExpandedBody(body: readonly string[]): string[] {
    const budget = this.expandedBodyBudget();
    if (body.length <= budget) {
      this.scrollTop = 0;
      return [...body];
    }
    const max = body.length - budget;
    if (this.scrollTop > max) this.scrollTop = max;
    return body.slice(this.scrollTop, this.scrollTop + budget);
  }

  setTodos(todos: readonly TodoItem[]): void {
    this.todos = todos.map((todo) => ({ ...todo }));
    // A shrinking list can leave the offset past the end.
    this.scrollTop = Math.min(this.scrollTop, this.hiddenExpandedRows());
  }

  getTodos(): readonly TodoItem[] {
    return this.todos;
  }

  clear(): void {
    this.todos = [];
    this.expanded = false;
  }

  isEmpty(): boolean {
    return this.todos.length === 0;
  }

  /** True when the list exceeds the collapsed cap, i.e. there is something to expand. */
  hasOverflow(): boolean {
    return this.todos.length > MAX_VISIBLE;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.scrollTop = 0;
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.scrollTop = 0;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.todos.length === 0) return [];
    const c = currentTheme.palette;
    const report = computePanelProgress(this.todos);
    const lines: string[] = [chalk.hex(c.border)('─'.repeat(width)), renderHeader(report, c)];

    const hasMilestones = this.todos.some((todo) => todo.kind === 'milestone');
    if (hasMilestones) {
      this.renderTree(report, c, lines);
    } else {
      this.renderFlat(c, lines);
    }

    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderTree(report: TodoProgressReport, c: ColorPalette, lines: string[]): void {
    const roots = buildTodoTree(this.todos);
    const activeRoot = roots.find(
      (node) =>
        node.item.kind === 'milestone' &&
        effectiveStatus(node.item, report.byId.get(node.item.id ?? node.item.title) ?? 0) ===
          'in_progress',
    );
    const activeChildren = activeRoot?.children.slice(0, MAX_ACTIVE_CHILD_ROWS) ?? [];

    if (this.expanded) {
      const body: string[] = [];
      for (const node of roots) {
        body.push(...renderMilestoneRow(node, report, c));
        for (const child of node.children) {
          body.push(renderLeafRow(child.item, report, c));
        }
      }
      lines.push(...this.sliceExpandedBody(body));
      if (!this.hintBudgetedOut()) lines.push(renderCollapseHint(this.todos.length, c));
      return;
    }

    for (const node of roots) {
      lines.push(...renderMilestoneRow(node, report, c));
      if (node === activeRoot) {
        for (const child of activeChildren) {
          lines.push(renderLeafRow(child.item, report, c));
        }
        const hiddenChildren = node.children.length - activeChildren.length;
        if (hiddenChildren > 0) {
          lines.push(renderHiddenChildrenHint(hiddenChildren, c));
        }
      }
    }
    const hidden = this.todos.length - (roots.length + activeChildren.length);
    if (hidden > 0) {
      const counts = countHidden(roots, activeRoot, activeChildren.length);
      lines.push(renderExpandHint(hidden, counts, c));
    }
  }

  private renderFlat(c: ColorPalette, lines: string[]): void {
    if (this.expanded) {
      const body = this.todos.map((todo) => renderFlatRow(todo, c));
      lines.push(...this.sliceExpandedBody(body));
      if (this.todos.length > MAX_VISIBLE && !this.hintBudgetedOut()) {
        lines.push(renderCollapseHint(this.todos.length, c));
      }
      return;
    }
    const { rows, hidden, hiddenCounts } = selectVisibleTodos(this.todos);
    for (const todo of rows) {
      lines.push(renderFlatRow(todo, c));
    }
    if (hidden > 0) {
      lines.push(renderExpandHint(hidden, hiddenCounts, c));
    }
  }
}

function renderHeader(report: TodoProgressReport, c: ColorPalette): string {
  const label = t('tui.chrome.todoPanel.overallProgress', {
    done: report.done,
    total: report.total,
    percent: report.overall,
  });
  const braille = renderBrailleBar(report.overall, BRAILLE_BAR_WIDTH, c.primary, c.border);
  const status = renderStatusBar(report.overall, STATUS_BAR_WIDTH, c.primary, c.border);
  return (
    chalk.hex(c.primary).bold(`  ${t('tui.chrome.todoPanel.header')}`) +
    `  ${label}  ${braille}  ${status}`
  );
}

function renderMilestoneRow(node: TodoNode, report: TodoProgressReport, c: ColorPalette): string[] {
  const key = node.item.id ?? node.item.title;
  const progress = report.byId.get(key) ?? 0;
  const status = effectiveStatus(node.item, progress);
  const marker =
    status === 'done'
      ? chalk.hex(c.success)('✓')
      : status === 'in_progress'
        ? chalk.hex(c.primary).bold('◆')
        : chalk.hex(c.textDim)('◆');
  const doneChildren = node.children.filter((child) => child.item.status === 'done').length;
  const countLabel = `${doneChildren}/${node.children.length}`;
  const title = styleTitle(node.item.title, status, c);
  const percent = node.children.length > 0 ? ` · ${progress}%` : '';
  const bar =
    node.children.length > 0 && progress < 100
      ? ` ${renderBrailleBar(progress, 4, c.primary, c.border)}`
      : '';
  return [`  ${marker} ${title}  ${chalk.hex(c.textDim)(`${countLabel}${percent}`)}${bar}`];
}

function renderLeafRow(item: TodoItem, report: TodoProgressReport, c: ColorPalette): string {
  const key = item.id ?? item.title;
  const progress = report.byId.get(key) ?? 0;
  const status = effectiveStatus(item, progress);
  const marker = statusMarker(status, c);
  const title = styleTitle(item.title, status, c);
  const percent =
    item.status === 'done' || progress === 0 ? '' : `  ${chalk.hex(c.textDim)(`${progress}%`)}`;
  return `  ${chalk.hex(c.border)('│')}   ${marker} ${title}${percent}`;
}

function renderFlatRow(item: TodoItem, c: ColorPalette): string {
  const marker = statusMarker(item.status, c);
  const title = styleTitle(item.title, item.status, c);
  return `  ${marker} ${title}`;
}

function renderCollapseHint(count: number, c: ColorPalette): string {
  return chalk.hex(c.textDim)(`  ${t('tui.chrome.todoPanel.collapseHint', { count })}`);
}

function renderHiddenChildrenHint(count: number, c: ColorPalette): string {
  return chalk.hex(c.textDim)(`  ${t('tui.chrome.todoPanel.hiddenChildren', { count })}`);
}

function renderExpandHint(
  hidden: number,
  counts: Record<TodoStatus, number>,
  c: ColorPalette,
): string {
  const distribution = formatHiddenCounts(counts);
  const suffix = distribution.length > 0 ? ` (${distribution})` : '';
  return chalk.hex(c.textDim)(
    `  ${t('tui.chrome.todoPanel.expandHint', { count: hidden, distribution: suffix })}`,
  );
}

function countHidden(
  roots: readonly TodoNode[],
  activeRoot: TodoNode | undefined,
  activeChildrenShown: number,
): Record<TodoStatus, number> {
  const counts: Record<TodoStatus, number> = { done: 0, in_progress: 0, pending: 0 };
  for (const node of roots) {
    if (node === activeRoot) {
      for (const child of node.children.slice(activeChildrenShown)) {
        counts[child.item.status] += 1;
      }
      continue;
    }
    for (const child of node.children) {
      counts[child.item.status] += 1;
    }
  }
  return counts;
}

function statusMarker(status: TodoStatus, colors: ColorPalette): string {
  switch (status) {
    case 'in_progress':
      return chalk.hex(colors.primary).bold('●');
    case 'done':
      return chalk.hex(colors.success)('✓');
    case 'pending':
      return chalk.hex(colors.textDim)('○');
  }
}

function styleTitle(title: string, status: TodoStatus, colors: ColorPalette): string {
  switch (status) {
    case 'in_progress':
      return chalk.hex(colors.text).bold(title);
    case 'done':
      return chalk.hex(colors.textDim).strikethrough(title);
    case 'pending':
      return chalk.hex(colors.text)(title);
  }
}

function getStatusLabels(): readonly { status: TodoStatus; label: string }[] {
  return [
    { status: 'done', label: t('tui.chrome.todoPanel.statusDone') },
    { status: 'in_progress', label: t('tui.chrome.todoPanel.statusInProgress') },
    { status: 'pending', label: t('tui.chrome.todoPanel.statusPending') },
  ];
}

export function formatHiddenCounts(counts: Record<TodoStatus, number>): string {
  return getStatusLabels()
    .filter(({ status }) => counts[status] > 0)
    .map(({ status, label }) => `${counts[status]} ${label}`)
    .join(' · ');
}
