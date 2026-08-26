/** @jsxImportSource @opentui/solid */
/**
 * TUI2 todo panel — live-updating TODO list shown before the input area.
 *
 * Replaces `tui/components/chrome/todo-panel.ts`'s `TodoPanelComponent`
 * (a pi-tui `Component` with imperative `setTodos` / `requestRender`)
 * with an opentui SolidJS view that reads `store.state.todoItems` — the
 * tui2 session event handler writes that slice whenever the LLM invokes
 * the `TodoList` tool, and the reconciler re-renders the panel
 * automatically. State survives across turns so the list stays visible
 * until explicitly cleared (`todos: []`), a new session starts, or
 * `/clear` is issued.
 *
 * Expansion state lives on the store (`todoPanelExpanded`); clicking the
 * panel toggles it. The pure selection logic (`selectVisibleTodos`,
 * `formatHiddenCounts`) is kept verbatim from v1 so the collapsed view
 * shows the same "what's next / what just finished" rows.
 *
 * Milestone support mirrors v1 (`buildTodoTree`, `computePanelProgress`):
 * items carrying `kind: 'milestone'` render as a tree with a progress
 * header (braille + status bar) and per-item percentages. Items without
 * milestone markers fall back to the flat selector below.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { For, Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'
import { useTui2Store } from '../../state'
import { currentTheme } from '../../theme'
import type { TodoItem } from '../../types'

import { Box } from '../common/box'
import { Clickable } from '../common/clickable'
import { Text } from '../common/text'

export type { TodoItem }
export type TodoStatus = 'pending' | 'in_progress' | 'done';
export type TodoKind = 'milestone' | 'task';

/** View-level todo item: the store slice plus the optional tree fields. */
export interface PanelTodoItem extends TodoItem {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly kind?: TodoKind;
  readonly progress?: number;
}

export interface TodoProgressReport {
  readonly overall: number;
  readonly done: number;
  readonly total: number;
  readonly byId: ReadonlyMap<string, number>;
}

export interface TodoNode {
  readonly item: PanelTodoItem;
  readonly children: readonly TodoNode[];
}

const MAX_VISIBLE = 5;
const MAX_ACTIVE_CHILD_ROWS = 4;
const BRAILLE_BAR_WIDTH = 5;
const STATUS_BAR_WIDTH = 10;
/** Mini bar rendered after a milestone row's count label. */
const MILESTONE_BAR_WIDTH = 4;

const BRAILLE_LEVELS = ['⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const;

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/**
 * Per-cell braille fill level (0..BRAILLE_LEVELS.length-1) for a progress
 * bar — the opentui counterpart of v1's chalk-based `renderBrailleBar`.
 */
export function brailleCellLevels(percent: number, width: number): number[] {
  const cells = Math.max(0, Math.floor(width));
  if (cells === 0) return [];
  const levels = BRAILLE_LEVELS.length;
  const totalTicks = cells * levels;
  const filledTicks = Math.round((clampPercent(percent) / 100) * totalTicks);
  const out: number[] = [];
  for (let cell = 0; cell < cells; cell += 1) {
    out.push(Math.max(0, Math.min(levels - 1, filledTicks - cell * levels)));
  }
  return out;
}

/** Number of filled `━` cells for the flat status bar next to the header. */
export function statusBarFillCount(percent: number, width: number): number {
  const cells = Math.max(0, Math.floor(width));
  if (cells === 0) return 0;
  return Math.round((clampPercent(percent) / 100) * cells);
}

const keyOf = (item: PanelTodoItem): string => item.id ?? item.title;

export function buildTodoTree(todos: readonly PanelTodoItem[]): readonly TodoNode[] {
  const known = new Set(todos.map(keyOf));
  const childrenOf = new Map<string, PanelTodoItem[]>();
  const topLevel: PanelTodoItem[] = [];
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
  const build = (item: PanelTodoItem): TodoNode => ({
    item,
    children: (childrenOf.get(keyOf(item)) ?? []).map(build),
  });
  return topLevel.map(build);
}

function leafProgress(item: PanelTodoItem): number {
  if (item.status === 'done') return 100;
  if (item.status === 'in_progress') return item.progress ?? 0;
  return 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((acc, v) => acc + v, 0) / values.length);
}

export function computePanelProgress(todos: readonly PanelTodoItem[]): TodoProgressReport {
  if (todos.length === 0) {
    return { overall: 0, done: 0, total: 0, byId: new Map() };
  }
  const childrenOf = new Map<string, PanelTodoItem[]>();
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
  const done = todos.filter(
    (item) =>
      item.kind === 'milestone' ? (byId.get(keyOf(item)) ?? 0) >= 100 : item.status === 'done',
  ).length;
  return { overall: mean(milestoneValues), done, total: todos.length, byId };
}

function effectiveStatus(item: PanelTodoItem, progress: number): TodoStatus {
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

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case 'in_progress':
      return '\u25C6'; // ◆ — milestones use a diamond, leaves a circle
    case 'done':
      return '\u2713';
    case 'pending':
      return '\u25C6';
  }
}

function leafMarker(status: TodoStatus): string {
  switch (status) {
    case 'in_progress':
      return '\u25CF';
    case 'done':
      return '\u2713';
    case 'pending':
      return '\u25CB';
  }
}

function markerColor(status: TodoStatus): ColorInput {
  switch (status) {
    case 'in_progress':
      return currentTheme.color('primary');
    case 'done':
      return currentTheme.color('success');
    case 'pending':
      return currentTheme.color('textDim');
  }
}

function titleAttributes(status: TodoStatus): number | undefined {
  if (status === 'in_progress') return currentTheme.attributes('bold');
  if (status === 'done') return currentTheme.attributes('strikethrough');
  return undefined;
}

function titleColor(status: TodoStatus): ColorInput {
  return status === 'done' ? currentTheme.color('textDim') : currentTheme.color('text');
}

function BrailleBar(props: { percent: number; width: number }) {
  const levels = (): number[] => brailleCellLevels(props.percent, props.width);
  return (
    <For each={levels()}>
      {(level) => (
        <Text fg={level > 0 ? currentTheme.color('primary') : currentTheme.color('border')}>
          {BRAILLE_LEVELS[level]}
        </Text>
      )}
    </For>
  );
}

function StatusBar(props: { percent: number; width: number }) {
  const filled = (): number => statusBarFillCount(props.percent, props.width);
  return (
    <>
      <Show when={filled() > 0}>
        <Text fg={currentTheme.color('primary')}>{'━'.repeat(filled())}</Text>
      </Show>
      <Text fg={currentTheme.color('border')}>
        {'░'.repeat(Math.max(0, props.width - filled()))}
      </Text>
    </>
  );
}

function ProgressHeader(props: { report: TodoProgressReport }) {
  const label = (): string =>
    t('tui.chrome.todoPanel.overallProgress', {
      done: props.report.done,
      total: props.report.total,
      percent: props.report.overall,
    });
  return (
    <Box flexDirection="row">
      <Text fg={currentTheme.color('primary')} attributes={currentTheme.attributes('bold')}>
        {'  '}
        {t('tui.chrome.todoPanel.header')}
      </Text>
      <Text>{'  '}</Text>
      <Text fg={currentTheme.color('textDim')}>{label()}</Text>
      <Text>{'  '}</Text>
      <BrailleBar percent={props.report.overall} width={BRAILLE_BAR_WIDTH} />
      <Text>{'  '}</Text>
      <StatusBar percent={props.report.overall} width={STATUS_BAR_WIDTH} />
    </Box>
  );
}

function MilestoneRow(props: { node: TodoNode; report: TodoProgressReport }) {
  const progress = (): number =>
    props.report.byId.get(keyOf(props.node.item)) ?? 0;
  const status = (): TodoStatus => effectiveStatus(props.node.item, progress());
  const doneChildren = (): number =>
    props.node.children.filter((child) => child.item.status === 'done').length;
  const countLabel = (): string =>
    `${doneChildren()}/${props.node.children.length}`;
  const percentLabel = (): string =>
    props.node.children.length > 0 ? ` · ${progress()}%` : '';
  return (
    <Box flexDirection="row">
      <Text fg={currentTheme.color('text')}>{'  '}</Text>
      <Show
        when={status() === 'in_progress'}
        fallback={<Text fg={markerColor(status())}>{statusMarker(status())}</Text>}
      >
        <Text
          fg={currentTheme.color('primary')}
          attributes={currentTheme.attributes('bold')}
        >
          {statusMarker('in_progress')}
        </Text>
      </Show>
      <Text>{' '}</Text>
      <Text fg={titleColor(status())} attributes={titleAttributes(status())}>
        {props.node.item.title}
      </Text>
      <Text>{'  '}</Text>
      <Text fg={currentTheme.color('textDim')}>{`${countLabel()}${percentLabel()}`}</Text>
      <Show when={props.node.children.length > 0 && progress() < 100}>
        <Text>{' '}</Text>
        <BrailleBar percent={progress()} width={MILESTONE_BAR_WIDTH} />
      </Show>
    </Box>
  );
}

function LeafRow(props: { item: PanelTodoItem; report: TodoProgressReport }) {
  const progress = (): number => props.report.byId.get(keyOf(props.item)) ?? 0;
  const status = (): TodoStatus => effectiveStatus(props.item, progress());
  const percentLabel = (): string =>
    props.item.status === 'done' || progress() === 0 ? '' : `  ${progress()}%`;
  return (
    <Box flexDirection="row">
      <Text fg={currentTheme.color('border')}>{'  │   '}</Text>
      <Text fg={markerColor(status())}>{leafMarker(status())}</Text>
      <Text>{' '}</Text>
      <Text fg={titleColor(status())} attributes={titleAttributes(status())}>
        {props.item.title}
      </Text>
      <Text fg={currentTheme.color('textDim')}>{percentLabel()}</Text>
    </Box>
  );
}

function FlatRow(props: { todo: TodoItem }) {
  return (
    <Box flexDirection="row">
      <Text fg={currentTheme.color('text')}>{'  '}</Text>
      <Text
        fg={markerColor(props.todo.status)}
        attributes={
          props.todo.status === 'in_progress' ? currentTheme.attributes('bold') : undefined
        }
      >
        {leafMarker(props.todo.status)}
      </Text>
      <Text>{' '}</Text>
      <Text fg={titleColor(props.todo.status)} attributes={titleAttributes(props.todo.status)}>
        {props.todo.title}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TodoPanelView: Component = () => {
  const store = useTui2Store()

  const todos = (): readonly PanelTodoItem[] => store.state.todoItems
  const expanded = (): boolean => store.state.todoPanelExpanded
  const hasOverflow = (): boolean => todos().length > MAX_VISIBLE
  const hasMilestones = (): boolean => todos().some((todo) => todo.kind === 'milestone')
  const report = (): TodoProgressReport => computePanelProgress(todos())
  const roots = (): readonly TodoNode[] => buildTodoTree(todos())

  /** The first milestone whose effective status is in_progress. */
  const activeRoot = (): TodoNode | undefined =>
    roots().find(
      (node) =>
        node.item.kind === 'milestone' &&
        effectiveStatus(node.item, report().byId.get(keyOf(node.item)) ?? 0) === 'in_progress',
    );

  const toggleExpanded = (): void => {
    store.setState('todoPanelExpanded', !expanded());
  };

  const collapseHint = (): string =>
    `  ${t('tui.chrome.todoPanel.collapseHint', { count: todos().length })}`
  const expandHint = (): string => {
    const { hidden, hiddenCounts } = selectVisibleTodos(todos());
    const distribution = formatHiddenCounts(hiddenCounts);
    const suffix = distribution.length > 0 ? ` (${distribution})` : '';
    return `  ${t('tui.chrome.todoPanel.expandHint', { count: hidden, distribution: suffix })}`
  }
  const hiddenChildrenHint = (count: number): string =>
    `  ${t('tui.chrome.todoPanel.hiddenChildren', { count })}`

  /** Collapsed tree: every milestone row + the active milestone's children. */
  const collapsedTreeRows = (): unknown => {
    const active = activeRoot();
    const activeChildren = active?.children.slice(0, MAX_ACTIVE_CHILD_ROWS) ?? [];
    return (
      <>
        <For each={roots()}>
          {(node) => (
            <>
              <MilestoneRow node={node} report={report()} />
              <Show when={node === active}>
                <For each={activeChildren}>
                  {(child) => <LeafRow item={child.item} report={report()} />}
                </For>
                <Show when={node.children.length - activeChildren.length > 0}>
                  <Text fg={currentTheme.color('textDim')}>
                    {hiddenChildrenHint(node.children.length - activeChildren.length)}
                  </Text>
                </Show>
              </Show>
            </>
          )}
        </For>
        {/* Hidden rows across non-active milestones → expand hint. */}
        <Show when={todos().length - (roots().length + activeChildren.length) > 0}>
          <Text fg={currentTheme.color('textDim')}>{expandHintTree()}</Text>
        </Show>
      </>
    )
  };

  /**
   * Expand hint for the tree view: hidden child count plus the per-status
   * distribution over the children that are not on screen.
   */
  const expandHintTree = (): string => {
    const active = activeRoot();
    const activeShown = active?.children.slice(0, MAX_ACTIVE_CHILD_ROWS).length ?? 0;
    const counts: Record<TodoStatus, number> = { done: 0, in_progress: 0, pending: 0 };
    let hidden = 0;
    for (const node of roots()) {
      const shown = node === active ? activeShown : 0;
      hidden += node.children.length - shown;
      for (const child of node.children.slice(shown)) {
        counts[child.item.status] += 1;
      }
    }
    const distribution = formatHiddenCounts(counts);
    const suffix = distribution.length > 0 ? ` (${distribution})` : '';
    return `  ${t('tui.chrome.todoPanel.expandHint', { count: hidden, distribution: suffix })}`;
  };

  return (
    <Show when={todos().length > 0}>
      <Clickable onClick={toggleExpanded}>
        <Box flexDirection="column">
          <Box border={['top']} borderStyle="single" borderColor={currentTheme.color('border')} />
          <ProgressHeader report={report()} />
          {hasMilestones() ? (
            expanded() ? (
              <>
                <For each={roots()}>
                  {(node) => (
                    <>
                      <MilestoneRow node={node} report={report()} />
                      <For each={node.children}>
                        {(child) => <LeafRow item={child.item} report={report()} />}
                      </For>
                    </>
                  )}
                </For>
                <Text fg={currentTheme.color('textDim')}>{collapseHint()}</Text>
              </>
            ) : (
              collapsedTreeRows()
            )
          ) : expanded() ? (
            <>
              <For each={todos()}>{(todo) => <FlatRow todo={todo} />}</For>
              <Show when={hasOverflow()}>
                <Text fg={currentTheme.color('textDim')}>{collapseHint()}</Text>
              </Show>
            </>
          ) : (
            <>
              <For each={selectVisibleTodos(todos()).rows}>{(todo) => <FlatRow todo={todo} />}</For>
              <Show when={selectVisibleTodos(todos()).hidden > 0}>
                <Text fg={currentTheme.color('textDim')}>{expandHint()}</Text>
              </Show>
            </>
          )}
        </Box>
      </Clickable>
    </Show>
  )
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
