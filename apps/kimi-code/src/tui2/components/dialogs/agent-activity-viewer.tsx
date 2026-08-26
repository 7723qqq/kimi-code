/** @jsxImportSource @opentui/solid */
/**
 * TUI2 agent activity viewer — full-screen detail view for a background
 * agent task.
 *
 * Replaces the v1 `AgentActivityViewer` (a pi-tui `Container`) with an
 * opentui SolidJS view. The body is assembled from the in-memory
 * `SubagentActivityRecord`: per-step heading, recent assistant text tail,
 * per-tool-call header, and the tool result chip. Markdown rendering for
 * the message bodies reuses the v1 `AssistantMessageComponent` until the
 * messages tree is migrated; once that lands the rendering path can be
 * swapped without touching this view's shape.
 *
 * Keyboard: ↑/↓ / k / j line scroll, PgUp/PgDn page, Home/End (g/G)
 * top/bottom, Ctrl+O toggles a global expand of every tool result,
 * Esc / q closes.
 *
 * Status: REAL (tui2, body uses v1 message renderer). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import type { BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk'

import { t } from '#/i18n'

import { MESSAGE_INDENT, RESULT_PREVIEW_LINES } from '../../constant/rendering'
import { STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { printableChar } from '../../utils/printable-key'
import type {
  SubagentActivityRecord,
  SubToolCallActivity,
} from '../../controllers/subagent-activity-store'
import { pickChip } from '../messages/tool-renderers/chip'
import type { ToolCallBlockData } from '../../types'

import { Box } from '../common/box'
import { Text } from '../common/text'

const ELLIPSIS = '…'

export interface AgentActivityViewerProps {
  readonly taskId: string
  readonly info: BackgroundTaskInfo | undefined
  readonly record: SubagentActivityRecord | undefined
  readonly width: number
  readonly viewRows: number
  readonly workspaceDir?: string
  readonly onClose: () => void
}

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

function extractKeyArgument(name: string, args: Record<string, unknown>, workspaceDir?: string): string | null {
  const keyMap: Record<string, readonly string[]> = {
    Bash: ['command'],
    Read: ['path', 'file_path'],
    Write: ['path', 'file_path'],
    Edit: ['path', 'file_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    FetchURL: ['url'],
    WebSearch: ['query'],
    Agent: ['description', 'prompt'],
  }
  const keys = keyMap[name] ?? []
  for (const key of keys) {
    const value = args[key]
    if (typeof value !== 'string' || value.length === 0) continue
    const trimmed = value.replaceAll(/\s+/g, ' ').trim()
    if (trimmed.length === 0) continue
    const prefix = workspaceDir !== undefined && workspaceDir.length > 0
      ? `${workspaceDir.replaceAll('\\', '/')}/`
      : ''
    const relative = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed
    return relative.length > 60 ? `${relative.slice(0, 59)}${ELLIPSIS}` : relative
  }
  return null
}

function sanitizeLiveOutput(value: string): string {
  let result = ''
  let i = 0
  while (i < value.length) {
    const code = value.charCodeAt(i)
    if (code === 0x1b) {
      const next = value.charCodeAt(i + 1)
      if (next === 0x5b) {
        i += 2
        while (i < value.length) {
          const c = value.charCodeAt(i)
          i += 1
          if (c >= 0x40 && c <= 0x7e) break
        }
        continue
      }
      if (next === 0x5d) {
        i += 2
        while (i < value.length) {
          const c = value.charCodeAt(i)
          i += 1
          if (c === 0x07) break
          if (c === 0x1b && value.charCodeAt(i) === 0x5c) {
            i += 1
            break
          }
        }
        continue
      }
      i += 1
      continue
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      i += 1
      continue
    }
    result += value[i]!
    i += 1
  }
  return result
}

function buildLines(record: SubagentActivityRecord | undefined, expanded: boolean, width: number): string[] {
  if (record === undefined) return [`${MESSAGE_INDENT}${t('tui.dialogs.agentActivityViewer.noActivity')}`]
  const out: string[] = []
  for (const step of record.steps) {
    out.push(`── step ${String(step.step)} ──`)
    if (step.retrying !== undefined) {
      out.push(`${MESSAGE_INDENT}↻ ${step.retrying}`)
    }
    if (step.textTail.trim().length > 0) {
      for (const line of step.textTail.trimEnd().split('\n')) {
        out.push(`${MESSAGE_INDENT}${line}`)
      }
    }
    for (const call of step.toolCalls) {
      out.push(buildToolCallHeader(call))
      out.push(...renderToolCallBody(call, expanded))
    }
    out.push('')
  }
  if (record.error !== undefined && record.error.length > 0) {
    out.push(t('tui.dialogs.agentActivityViewer.failed'))
    for (const line of record.error.trimEnd().split('\n')) {
      out.push(`${MESSAGE_INDENT}${line}`)
    }
  } else if (record.resultSummary !== undefined && record.resultSummary.length > 0) {
    out.push(t('tui.dialogs.agentActivityViewer.result'))
    for (const line of record.resultSummary.trimEnd().split('\n')) {
      out.push(`${MESSAGE_INDENT}${line}`)
    }
  }
  if (out.length === 0) {
    out.push(`${MESSAGE_INDENT}${t('tui.dialogs.agentActivityViewer.waiting')}`)
  }
  void width
  return out
}

function buildToolCallHeader(call: SubToolCallActivity): string {
  const bullet =
    call.status === 'error' ? '✗' : STATUS_BULLET
  const verb =
    call.status === 'running'
      ? t('tui.dialogs.agentActivityViewer.using')
      : t('tui.dialogs.agentActivityViewer.used')
  const keyArg = extractKeyArgument(call.name, call.args)
  const argStr = keyArg === null || keyArg.length === 0 ? '' : ` (${keyArg})`
  // Same chip as the main transcript card (line counts / sizes / exit codes).
  let chipStr = ''
  if (call.result !== undefined) {
    const provider = pickChip(call.name)
    const text = provider?.(toToolCallBlockData(call), call.result) ?? ''
    if (text.length > 0) {
      chipStr = ` · ${text}`
    }
  }
  return `${bullet} ${verb} ${call.name}${argStr}${chipStr}`
}

function renderToolCallBody(call: SubToolCallActivity, expanded: boolean): string[] {
  if (call.result === undefined) {
    if (call.liveOutputTail !== undefined && call.liveOutputTail.length > 0) {
      return [`${MESSAGE_INDENT}│ ${sanitizeLiveOutput(call.liveOutputTail)}`]
    }
    return []
  }
  if (call.name === 'ReadMediaFile' && call.result.is_error !== true) {
    return [`${MESSAGE_INDENT}${t('tui.dialogs.agentActivityViewer.mediaOutputOmitted')}`]
  }
  const out: string[] = []
  if (call.result.output !== undefined && call.result.output.length > 0) {
    const all = call.result.output.split('\n')
    const shown = expanded ? all : all.slice(0, RESULT_PREVIEW_LINES)
    for (const line of shown) {
      out.push(`${MESSAGE_INDENT}${line}`)
    }
    if (!expanded && all.length > RESULT_PREVIEW_LINES) {
      const more = all.length - RESULT_PREVIEW_LINES
      out.push(`${MESSAGE_INDENT}${t('tui.dialogs.agentActivityViewer.moreLine', { count: String(more) })}`)
    }
  }
  if (call.result.is_error === true) {
    out.push(`${MESSAGE_INDENT}${t('tui.dialogs.agentActivityViewer.errorTag')}`)
  }
  return out
}

function toToolCallBlockData(call: SubToolCallActivity): ToolCallBlockData {
  return { id: call.id, name: call.name, args: call.args }
}

function statusColorToken(status: BackgroundTaskInfo['status']): 'success' | 'textMuted' | 'error' {
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

function statusLabelText(status: BackgroundTaskInfo['status']): string {
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

export const AgentActivityViewer: Component<AgentActivityViewerProps> = (props) => {
  const [scrollTop, setScrollTop] = createSignal(0)
  const [expanded, setExpanded] = createSignal(false)
  const [followTail, setFollowTail] = createSignal(true)

  const lines = (): readonly string[] => buildLines(props.record, expanded(), props.width)
  const viewRows = (): number => Math.max(1, props.viewRows - 2)
  const innerWidth = (): number => Math.max(1, props.width - 4)
  const maxScroll = (): number => Math.max(0, lines().length - viewRows())

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    if (event.ctrl && event.name === 'o') {
      event.stopPropagation()
      setExpanded((e) => !e)
      return
    }
    if (event.name === 'up') {
      setScrollTop((t) => Math.max(0, t - 1))
      setFollowTail(false)
      return
    }
    if (event.name === 'down') {
      setScrollTop((t) => Math.min(maxScroll(), t + 1))
      setFollowTail(scrollTop() >= maxScroll())
      return
    }
    if (event.name === 'pageup' || (event.ctrl && event.name === 'u')) {
      setScrollTop((t) => Math.max(0, t - Math.max(1, viewRows() - 1)))
      setFollowTail(false)
      return
    }
    if (event.name === 'pagedown' || (event.ctrl && event.name === 'd')) {
      setScrollTop((t) => Math.min(maxScroll(), t + Math.max(1, viewRows() - 1)))
      setFollowTail(scrollTop() >= maxScroll())
      return
    }
    if (event.name === 'home') {
      setScrollTop(0)
      setFollowTail(false)
      return
    }
    if (event.name === 'end') {
      setScrollTop(maxScroll())
      setFollowTail(true)
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
      setFollowTail(false)
      return
    }
    if (ch === 'j' || ch === 'J') {
      setScrollTop((t) => Math.min(maxScroll(), t + 1))
      setFollowTail(scrollTop() >= maxScroll())
      return
    }
    if (ch === 'g') {
      setScrollTop(0)
      setFollowTail(false)
      return
    }
    if (ch === 'G') {
      setScrollTop(maxScroll())
      setFollowTail(true)
      return
    }
    if (event.name === 'escape') {
      event.stopPropagation()
      props.onClose()
    }
  }

  if (followTail()) {
    setScrollTop(maxScroll())
  }
  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const successFg = (): ColorInput => currentTheme.color('success')

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box flexDirection="row">
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.agentActivityViewer.title')} `}</Text>
        <Text fg={titleFg()} attributes={titleAttrs()}>{props.record?.agentName ?? props.taskId}</Text>
        <Show when={props.info !== undefined}>
          <Text>{'  '}</Text>
          <Text fg={currentTheme.color(statusColorToken(props.info?.status ?? 'completed'))}>
            {statusLabelText(props.info?.status ?? 'completed')}
          </Text>
        </Show>
        <Show when={props.record !== undefined && (props.record?.steps.length ?? 0) > 0}>
          <Text>{'  '}</Text>
          <Text fg={textMutedFg()}>{`step ${String(props.record?.steps[0]?.step ?? 0)}–${String(props.record?.steps.at(-1)?.step ?? 0)} / ${String(props.record?.totalSteps ?? 0)}`}</Text>
        </Show>
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
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.agentActivityViewer.footer.line')}  `}</Text>
        <Text fg={titleFg()} attributes={titleAttrs()}>{'PgUp/PgDn'}</Text>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.agentActivityViewer.footer.page')}  `}</Text>
        <Text fg={titleFg()} attributes={titleAttrs()}>{'g/G'}</Text>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.agentActivityViewer.footer.topBottom')}  `}</Text>
        <Text fg={titleFg()} attributes={titleAttrs()}>{'Ctrl+O'}</Text>
        <Text fg={textMutedFg()}>{` ${expanded() ? t('tui.dialogs.agentActivityViewer.footer.collapse') : t('tui.dialogs.agentActivityViewer.footer.expand')}  `}</Text>
        <Text fg={titleFg()} attributes={titleAttrs()}>{'Q/Esc'}</Text>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.agentActivityViewer.footer.cancel')}`}</Text>
        <Text>{''}</Text>
        <Text fg={successFg()}>{` ${scrollTop() + 1}-${Math.min(lines().length, scrollTop() + viewRows())} / ${lines().length}`}</Text>
      </Box>
    </Box>
  )
}

/**
 * Plain-text preview of a record for the tasks browser's Preview frame.
 * Kept as a plain function so the controller (already in tui2) can format
 * the preview without instantiating the full viewer.
 */
export function formatSubagentActivityPreview(
  record: SubagentActivityRecord,
  workspaceDir?: string,
): string {
  const lines: string[] = []
  for (const step of record.steps) {
    lines.push(`── step ${String(step.step)} ──`)
    if (step.retrying !== undefined) lines.push(`${MESSAGE_INDENT}↻ ${step.retrying}`)
    if (step.textTail.trim().length > 0) lines.push(...step.textTail.trimEnd().split('\n'))
    for (const call of step.toolCalls) {
      const keyArg = extractKeyArgument(call.name, call.args, workspaceDir)
      const argStr = keyArg === null || keyArg.length === 0 ? '' : ` (${keyArg})`
      const mark = call.status === 'done' ? '✓' : call.status === 'error' ? '✗' : '●'
      const verb =
        call.status === 'running'
          ? t('tui.dialogs.agentActivityViewer.using')
          : t('tui.dialogs.agentActivityViewer.used')
      lines.push(`${mark} ${verb} ${call.name}${argStr}`)
      if (
        call.result === undefined &&
        call.liveOutputTail !== undefined &&
        call.liveOutputTail.length > 0
      ) {
        lines.push(`${MESSAGE_INDENT}│ ${sanitizeLiveOutput(call.liveOutputTail)}`)
      }
    }
  }
  if (record.error !== undefined && record.error.length > 0) {
    lines.push(
      t('tui.dialogs.agentActivityViewer.failedColon'),
      ...record.error.trimEnd().split('\n'),
    )
  } else if (record.resultSummary !== undefined && record.resultSummary.length > 0) {
    lines.push(
      t('tui.dialogs.agentActivityViewer.resultColon'),
      ...record.resultSummary.trimEnd().split('\n'),
    )
  }
  if (lines.length === 0) {
    return record.status === 'running' ? t('tui.dialogs.agentActivityViewer.waiting') : ''
  }
  return lines.join('\n')
}