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

const MAX_VISIBLE = 5;

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

export const TodoPanelView: Component = () => {
  const store = useTui2Store()

  const todos = (): readonly TodoItem[] => store.state.todoItems
  const expanded = (): boolean => store.state.todoPanelExpanded
  const hasOverflow = (): boolean => todos().length > MAX_VISIBLE

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

  return (
    <Show when={todos().length > 0}>
      <Clickable onClick={toggleExpanded}>
        <Box flexDirection="column">
          <Box border={['top']} borderStyle="single" borderColor={currentTheme.color('border')} />
          <Text fg={currentTheme.color('primary')} attributes={currentTheme.attributes('bold')}>
            {`  ${t('tui.chrome.todoPanel.header')}`}
          </Text>
          {expanded() ? (
            <>
              <For each={todos()}>{(todo) => <TodoRow todo={todo} />}</For>
              <Show when={hasOverflow()}>
                <Text fg={currentTheme.color('textDim')}>{collapseHint()}</Text>
              </Show>
            </>
          ) : (
            <>
              <For each={selectVisibleTodos(todos()).rows}>{(todo) => <TodoRow todo={todo} />}</For>
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

function TodoRow(props: { todo: TodoItem }) {
  const marker = (): string => statusMarker(props.todo.status)
  const markerFg = (): ColorInput => statusMarkerColor(props.todo.status)
  const markerBold = (): boolean => props.todo.status === 'in_progress'
  const titleFg = (): ColorInput =>
    props.todo.status === 'done' ? currentTheme.color('textDim') : currentTheme.color('text')
  const titleAttributes = (): number | undefined => {
    if (props.todo.status === 'in_progress') return currentTheme.attributes('bold');
    if (props.todo.status === 'done') return currentTheme.attributes('strikethrough');
    return undefined;
  }

  return (
    <Box flexDirection="row">
      <Text fg={currentTheme.color('text')}>{'  '}</Text>
      <Text fg={markerFg()} attributes={markerBold() ? currentTheme.attributes('bold') : undefined}>
        {marker()}
      </Text>
      <Text fg={titleFg()} attributes={titleAttributes()}>
        {` ${props.todo.title}`}
      </Text>
    </Box>
  )
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case 'in_progress':
      return '\u25CF';
    case 'done':
      return '\u2713';
    case 'pending':
      return '\u25CB';
  }
}

function statusMarkerColor(status: TodoStatus): ColorInput {
  switch (status) {
    case 'in_progress':
      return currentTheme.color('primary');
    case 'done':
      return currentTheme.color('success');
    case 'pending':
      return currentTheme.color('textDim');
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
