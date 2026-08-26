/** @jsxImportSource @opentui/solid */
/**
 * TUI2 tasks browser — full-screen alt-screen takeover for browsing
 * background tasks (left task list / right top detail / right bottom
 * preview).
 *
 * Replaces the v1 `TasksBrowserApp` (a pi-tui `Container`) with an
 * opentui SolidJS view. The store + controller live in
 * `tui2/controllers/tasks-browser.ts`; this view is the pure rendering
 * layer driven by the controller's `TasksBrowserState`. Key actions
 * (filter toggle, refresh, select, stop, open output) fire callbacks
 * back to the controller.
 *
 * Keyboard: ↑/↓ navigates the list, Tab toggles filter, Enter / `o`
 * opens output, `r` refreshes, `s` arms stop (then `y` / `n` /
 * `Esc`), Esc closes the browser.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@moonshot-ai/kimi-code-sdk'

import { t } from '#/i18n'

import { SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { printableChar } from '../../utils/printable-key'
import { sanitizeShellOutput } from '../../utils/shell-output'

import { Box } from '../common/box'
import { Clickable } from '../common/clickable'
import { Text } from '../common/text'

const ELLIPSIS = '…'

export type TasksFilter = 'all' | 'active'

export interface TasksBrowserProps {
  readonly tasks: readonly BackgroundTaskInfo[]
  readonly filter: TasksFilter
  readonly selectedTaskId: string | undefined
  readonly tailOutput: string | undefined
  readonly tailLoading: boolean
  readonly flashMessage: string | undefined
  readonly width: number
  readonly height: number
  readonly onSelect: (taskId: string) => void
  readonly onToggleFilter: () => void
  readonly onRefresh: () => void
  readonly onCancel: () => void
  readonly onStopConfirmed: (taskId: string) => void
  readonly onOpenOutput: (taskId: string) => void
  readonly onStopIgnored?: (taskId: string, reason: 'terminal') => void
}

const STOP_CONFIRM_TIMEOUT_MS = 5_000
const MIN_WIDTH = 48
const MIN_HEIGHT = 10
const LIST_COL_MIN = 28
const LIST_COL_MAX = 44
const LIST_COL_RATIO = 0.32

function statusColorToken(status: BackgroundTaskStatus): ColorToken {
  switch (status) {
    case 'running':
      return 'success'
    case 'completed':
      return 'textMuted'
    case 'failed':
    case 'timed_out':
    case 'killed':
    case 'lost':
      return 'error'
  }
}

type ColorToken = 'success' | 'textMuted' | 'error'

function isTerminal(status: BackgroundTaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'timed_out' ||
    status === 'killed' ||
    status === 'lost'
  )
}

function statusLabel(status: BackgroundTaskStatus): string {
  switch (status) {
    case 'running':
      return t('tui.dialogs.tasksBrowser.statusRunning')
    case 'completed':
      return t('tui.dialogs.tasksBrowser.statusCompleted')
    case 'failed':
      return t('tui.dialogs.tasksBrowser.statusFailed')
    case 'timed_out':
      return t('tui.dialogs.tasksBrowser.statusTimedOut')
    case 'killed':
      return t('tui.dialogs.tasksBrowser.statusKilled')
    case 'lost':
      return t('tui.dialogs.tasksBrowser.statusLost')
  }
}

export const TasksBrowser: Component<TasksBrowserProps> = (props) => {
  const [cursor, setCursor] = createSignal(0)
  const [stopArmed, setStopArmed] = createSignal<string | undefined>(undefined)
  let stopTimer: ReturnType<typeof setTimeout> | undefined

  function armStop(taskId: string): void {
    if (stopTimer !== undefined) clearTimeout(stopTimer)
    setStopArmed(taskId)
    stopTimer = setTimeout(() => {
      setStopArmed(undefined)
      stopTimer = undefined
    }, STOP_CONFIRM_TIMEOUT_MS)
  }

  function clearStop(): void {
    if (stopTimer !== undefined) clearTimeout(stopTimer)
    stopTimer = undefined
    setStopArmed(undefined)
  }

  const filtered = createMemo<readonly BackgroundTaskInfo[]>(() => {
    const all = props.tasks
    if (props.filter === 'all') return all
    return all.filter((task) => !isTerminal(task.status))
  })

  const selectedId = (): string | undefined => {
    const list = filtered()
    if (list.length === 0) return undefined
    return list[Math.min(cursor(), list.length - 1)]?.taskId ?? props.selectedTaskId
  }

  const selectedTask = (): BackgroundTaskInfo | undefined => {
    const id = selectedId()
    if (id === undefined) return undefined
    return props.tasks.find((task) => task.taskId === id)
  }

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    if (event.name === 'escape') {
      event.stopPropagation()
      clearStop()
      props.onCancel()
      return
    }
    // Stop confirmation substate.
    if (stopArmed() !== undefined) {
      const ch = printableChar(event.sequence ?? event.name)
      if (ch === 'y' || ch === 'Y') {
        event.stopPropagation()
        const id = stopArmed()
        if (id !== undefined) props.onStopConfirmed(id)
        clearStop()
        return
      }
      if (ch === 'n' || ch === 'N' || event.name === 'escape') {
        event.stopPropagation()
        clearStop()
      }
      return
    }
    if (event.name === 'tab') {
      event.stopPropagation()
      props.onToggleFilter()
      setCursor(0)
      return
    }
    if (event.name === 'up') {
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    if (event.name === 'down') {
      setCursor((c) => Math.min(filtered().length - 1, c + 1))
      return
    }
    if (event.name === 'return' || event.name === 'enter' || event.name === 'o' || event.name === 'O') {
      const id = selectedId()
      if (id !== undefined) {
        event.stopPropagation()
        props.onOpenOutput(id)
      }
      return
    }
    const ch = printableChar(event.sequence ?? event.name)
    if (ch === 'r' || ch === 'R') {
      event.stopPropagation()
      props.onRefresh()
      return
    }
    if (ch === 's' || ch === 'S') {
      const task = selectedTask()
      if (task !== undefined) {
        if (isTerminal(task.status)) {
          event.stopPropagation()
          props.onStopIgnored?.(task.taskId, 'terminal')
        } else {
          event.stopPropagation()
          armStop(task.taskId)
        }
      }
    }
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const textFg = (): ColorInput => currentTheme.color('text')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const accentFg = (): ColorInput => currentTheme.color('accent')
  const _successFg = (): ColorInput => currentTheme.color('success')

  if (props.width < MIN_WIDTH || props.height < MIN_HEIGHT) {
    return (
      <Box flexDirection="column">
        <Text>{`  ${t('tui.dialogs.tasksBrowser.tooSmall')}`}</Text>
      </Box>
    )
  }

  const listColWidth = (): number =>
    Math.max(
      LIST_COL_MIN,
      Math.min(LIST_COL_MAX, Math.floor(props.width * LIST_COL_RATIO)),
    )
  const detailColWidth = (): number => Math.max(20, props.width - listColWidth() - 4)
  const list = filtered()
  const task = selectedTask()

  const tailLines = (): readonly string[] => {
    if (props.tailLoading) return [t('tui.dialogs.tasksBrowser.tailLoading')]
    if (props.tailOutput === undefined || props.tailOutput.length === 0) {
      return [t('tui.dialogs.tasksBrowser.noTail')]
    }
    return sanitizeShellOutput(props.tailOutput).split('\n')
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box flexDirection="row">
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.tasksBrowser.title')} `}</Text>
        <Text fg={textMutedFg()}>{` (${String(list.length)}) `}</Text>
        <Show when={props.flashMessage !== undefined && (props.flashMessage ?? '').length > 0}>
          <Text>{'  '}</Text>
          <Text fg={accentFg()}>{props.flashMessage ?? ''}</Text>
        </Show>
      </Box>
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Body: list + detail */}
      <Box flexDirection="row">
        {/* Left: task list */}
        <Box flexDirection="column">
          <For each={list}>
            {(t_, i) => {
              const selected = (): boolean => i() === Math.min(cursor(), list.length - 1)
              const active = (): boolean => t_.status === 'running'
              return (
                <Clickable onClick={() => props.onSelect(t_.taskId)}>
                  <Box flexDirection="row">
                    <Text fg={selected() ? titleFg() : textDimFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
                    <Text
                      fg={selected() ? titleFg() : textFg()}
                      attributes={selected() ? titleAttrs() : undefined}
                    >
                      {t_.description.length > 0 ? t_.description : t_.taskId.slice(0, 12)}
                    </Text>
                    <Text>{'  '}</Text>
                    <Text fg={currentTheme.color(statusColorToken(t_.status))}>
                      {statusLabel(t_.status)}
                    </Text>
                    <Show when={active()}>
                      <Text>{' ●'}</Text>
                    </Show>
                  </Box>
                </Clickable>
              )
            }}
          </For>
          <Show when={list.length === 0}>
            <Box>
              <Text fg={textMutedFg()}>{`  ${t('tui.dialogs.tasksBrowser.empty')}`}</Text>
            </Box>
          </Show>
        </Box>
        {/* Vertical divider */}
        <Box>
          <Text>{' │ '}</Text>
        </Box>
        {/* Right: detail */}
        <Box flexDirection="column">
          <Show
            when={task !== undefined}
            fallback={
              <Box>
                <Text fg={textMutedFg()}>{t('tui.dialogs.tasksBrowser.noSelection')}</Text>
              </Box>
            }
          >
            {(() => {
              const tk = task
              if (tk === undefined) return null
              return (
                <>
                  <Box flexDirection="row">
                    <Text fg={titleFg()} attributes={titleAttrs()}>{` ${tk.taskId} `}</Text>
                    <Text fg={currentTheme.color(statusColorToken(tk.status))}>
                      {` ${statusLabel(tk.status)}`}
                    </Text>
                  </Box>
                  <Show when={tk.kind === 'agent'}>
                    <Box>
                      <Text fg={textMutedFg()}>{`  ${t('tui.dialogs.tasksBrowser.kindAgent', { agentName: tk.kind === 'agent' ? tk.subagentType ?? tk.agentId ?? '' : '' })}`}</Text>
                    </Box>
                  </Show>
                  <Show when={stopArmed() === tk.taskId}>
                    <Box>
                      <Text fg={accentFg()} attributes={titleAttrs()}>{`  ${t('tui.dialogs.tasksBrowser.stopConfirm', { id: tk.taskId })} [Y/n]`}</Text>
                    </Box>
                  </Show>
                </>
              )
            })()}
          </Show>
        </Box>
      </Box>
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Tail output preview (bottom pane) */}
      <Box flexDirection="column">
        <Box>
          <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.tasksBrowser.previewTitle')} `}</Text>
        </Box>
        <For each={tailLines().slice(-10)}>
          {(line) => (
            <Box>
              <Text>{`  ${line.length > detailColWidth() ? `${line.slice(0, Math.max(1, detailColWidth() - 1))}${ELLIPSIS}` : line}`}</Text>
            </Box>
          )}
        </For>
      </Box>
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Footer hint */}
      <Box>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.tasksBrowser.footerHint')}`}</Text>
      </Box>
    </Box>
  )
}