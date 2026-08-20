/** @jsxImportSource @opentui/solid */
/**
 * TUI2 task output viewer — full-screen snapshot viewer for a single
 * background task's output.
 *
 * Replaces the v1 `TaskOutputViewer` (a pi-tui `Container`) with an opentui
 * SolidJS view. The viewer is mounted by the host via the nested-takeover
 * pattern on top of `TasksBrowserApp`; output is fetched once at open.
 * Keyboard: ↑/↓ line scroll, PgUp/PgDn/Ctrl+U/Ctrl+D page, Home/End (g/G)
 * top/bottom, Esc / q close.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import type {
  BackgroundTaskInfo,
  BackgroundTaskStatus,
} from '@moonshot-ai/kimi-code-sdk'

import { t } from '#/i18n'

import { sanitizeShellOutput } from '../../utils/shell-output'
import { currentTheme } from '../../theme'
import { printableChar } from '../../utils/printable-key'

import { Box } from '../common/box'
import { Text } from '../common/text'

const ELLIPSIS = '…'

export interface TaskOutputViewerProps {
  readonly taskId: string
  readonly info: BackgroundTaskInfo | undefined
  readonly output: string
  readonly viewRows: number
  readonly width: number
  readonly onClose: () => void
}

export function statusLabel(status: BackgroundTaskStatus): string {
  switch (status) {
    case 'running':
      return t('tui.dialogs.taskOutputViewer.status.running')
    case 'completed':
      return t('tui.dialogs.taskOutputViewer.status.completed')
    case 'failed':
      return t('tui.dialogs.taskOutputViewer.status.failed')
    case 'timed_out':
      return t('tui.dialogs.taskOutputViewer.status.timedOut')
    case 'killed':
      return t('tui.dialogs.taskOutputViewer.status.killed')
    case 'lost':
      return t('tui.dialogs.taskOutputViewer.status.lost')
  }
}

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

function padToWidth(line: string, width: number): string {
  if (line.length === width) return line
  if (line.length > width) return `${line.slice(0, Math.max(1, width - 1))}${ELLIPSIS}`
  return line + ' '.repeat(width - line.length)
}

function fitExactly(line: string, width: number): string {
  let s = line
  if (s.length > width) s = `${s.slice(0, Math.max(1, width - 1))}${ELLIPSIS}`
  return padToWidth(s, width)
}

function splitOutput(output: string): string[] {
  return (
    output.length > 0 ? sanitizeShellOutput(output) : t('tui.dialogs.taskOutputViewer.noOutput')
  ).split('\n')
}

export const TaskOutputViewer: Component<TaskOutputViewerProps> = (props) => {
  const [scrollTop, setScrollTop] = createSignal(0)

  const lines = (): readonly string[] => splitOutput(props.output)
  const viewRows = (): number => Math.max(1, props.viewRows - 2)
  const innerWidth = (): number => Math.max(1, props.width - 4)
  const maxScroll = (): number => Math.max(0, lines().length - viewRows())

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    if (event.name === 'escape') {
      event.stopPropagation()
      props.onClose()
      return
    }
    if (event.name === 'up') {
      setScrollTop((t) => Math.max(0, t - 1))
      return
    }
    if (event.name === 'down') {
      setScrollTop((t) => Math.min(maxScroll(), t + 1))
      return
    }
    if (event.name === 'pageup' || (event.ctrl && event.name === 'u')) {
      setScrollTop((t) => Math.max(0, t - Math.max(1, viewRows() - 1)))
      return
    }
    if (event.name === 'pagedown' || (event.ctrl && event.name === 'd')) {
      setScrollTop((t) => Math.min(maxScroll(), t + Math.max(1, viewRows() - 1)))
      return
    }
    if (event.name === 'home') {
      setScrollTop(0)
      return
    }
    if (event.name === 'end') {
      setScrollTop(maxScroll())
      return
    }
    const ch = printableChar(event.sequence ?? event.name)
    if (ch === 'q' || ch === 'Q') {
      event.stopPropagation()
      props.onClose()
      return
    }
    if (ch === 'k' || ch === 'K') {
      setScrollTop((t) => Math.max(0, t - 1))
      return
    }
    if (ch === 'j' || ch === 'J') {
      setScrollTop((t) => Math.min(maxScroll(), t + 1))
      return
    }
    if (ch === 'g') {
      setScrollTop(0)
      return
    }
    if (ch === 'G') {
      setScrollTop(maxScroll())
      return
    }
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.taskOutputViewer.title')} `}</Text>
        <Text fg={titleFg()} attributes={titleAttrs()}>{props.taskId}</Text>
        <ShowInfo info={props.info} />
      </Box>
      {/* Body frame */}
      <Box>
        <Text fg={borderFg()}>{`┌${'─'.repeat(Math.max(0, props.width - 2))}┐`}</Text>
      </Box>
      <For each={Array.from({ length: viewRows() })}>
        {(_, i) => {
          const lineIndex = (): number => scrollTop() + i()
          const raw = (): string => lines()[lineIndex()] ?? ''
          return (
            <Box flexDirection="row">
              <Text fg={borderFg()}>{'│ '}</Text>
              <Text>{fitExactly(raw(), innerWidth())}</Text>
              <Text fg={borderFg()}>{' │'}</Text>
            </Box>
          )
        }}
      </For>
      <Box>
        <Text fg={borderFg()}>{`└${'─'.repeat(Math.max(0, props.width - 2))}┘`}</Text>
      </Box>
      {/* Footer */}
      <Box flexDirection="row">
        <Text>{' '}</Text>
        <Text fg={titleFg()} attributes={titleAttrs()}>{'↑↓'}</Text>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.taskOutputViewer.footer.line')}  `}</Text>
        <Text fg={titleFg()} attributes={titleAttrs()}>{'PgUp/PgDn/Ctrl+U/D'}</Text>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.taskOutputViewer.footer.page')}  `}</Text>
        <Text fg={titleFg()} attributes={titleAttrs()}>{'g/G'}</Text>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.taskOutputViewer.footer.topBottom')}  `}</Text>
        <Text fg={titleFg()} attributes={titleAttrs()}>{'Q/Esc'}</Text>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.taskOutputViewer.footer.cancel')}`}</Text>
        <Text>{''}</Text>
        <Text fg={textMutedFg()}>
          {(() => {
            const total = lines().length
            const view = viewRows()
            const max = Math.max(0, total - view)
            const percent = max === 0 ? 100 : Math.round((scrollTop() / max) * 100)
            const from = scrollTop() + 1
            const to = Math.min(total, scrollTop() + view)
            return ` ${from}-${to} / ${total} (${percent}%) `
          })()}
        </Text>
      </Box>
    </Box>
  )
}

function ShowInfo(props: { info: BackgroundTaskInfo | undefined }): unknown {
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  if (props.info === undefined) return null
  const info = props.info
  // Narrow the discriminated union once; <Show> children cannot see the
  // when-condition narrowing.
  const processInfo = info.kind === 'process' ? info : undefined
  return (
    <Box flexDirection="row">
      <Text>{'  '}</Text>
      <Text fg={currentTheme.color(statusColorToken(info.status))}>{statusLabel(info.status)}</Text>
      <Show when={processInfo !== undefined && processInfo.exitCode !== null}>
        <Text fg={textMutedFg()}>
          {`  ${t('tui.dialogs.taskOutputViewer.exitCode', { code: String(processInfo?.exitCode ?? '') })}`}
        </Text>
      </Show>
      <Show when={info.description !== undefined && info.description.length > 0}>
        <Text fg={textMutedFg()}>{`  ${info.description}`}</Text>
      </Show>
    </Box>
  )
}