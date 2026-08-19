/** @jsxImportSource @opentui/solid */
/**
 * TUI2 approval panel — modal approval request UI for SDK ask-for-approval
 * callbacks.
 *
 * Replaces the v1 `ApprovalPanelComponent` (a pi-tui `Container` with an
 * embedded `Input` for feedback) with an opentui SolidJS view. Renders
 * the request's display blocks (diff / file_content / shell / file_op /
 * url_fetch / search / invocation / brief / background_task / todo),
 * followed by a numbered choice list. Choices marked
 * `requires_feedback: true` enter an inline text-entry mode; the others
 * submit immediately on Enter (or by pressing the corresponding digit).
 *
 * Keyboard: ↑/↓ navigates, Enter submits, 1-9 shortcut, Esc / Ctrl+C /
 * Ctrl+D reject, Ctrl+E opens the preview viewer (delegated to the host),
 * Ctrl+O toggles tool output (delegated to the host).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import { highlightLines, langFromPath } from '../../../tui/components/media/code-highlight'
import { renderDiffLinesClustered } from '../../../tui/components/media/diff-preview'
import type {
  ApprovalPanelChoice,
  DiffDisplayBlock,
  DisplayBlock,
  FileContentDisplayBlock,
  PendingApproval,
} from '../../reverse-rpc/types'
import { currentTheme } from '../../theme'
import { isPrintableChar, printableChar } from '../../utils/printable-key'

import { Box } from '../common/box'
import { Text } from '../common/text'

const ELLIPSIS = '…'
const DIFF_SUMMARY_MAX_LINES = 10
const CONTENT_SUMMARY_MAX_LINES = 10

export interface ApprovalPanelResponse {
  readonly response: 'approved' | 'approved_for_session' | 'rejected' | 'cancelled'
  readonly feedback?: string | undefined
  readonly selected_label?: string | undefined
}

function truncateOneLine(text: string, max: number): string {
  const firstLine = text.split('\n')[0] ?? ''
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}${ELLIPSIS}` : firstLine
}

function wrapPlain(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const words = text.split(/\s+/).filter((word) => word.length > 0)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (candidate.length <= safeWidth) {
      current = candidate
      continue
    }
    if (current.length > 0) lines.push(current)
    current = word.length <= safeWidth ? word : `${word.slice(0, Math.max(1, safeWidth - 1))}${ELLIPSIS}`
  }
  if (current.length > 0) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

function headerFor(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return t('tui.dialogs.approvalPanel.headerForBash')
    case 'Write':
      return t('tui.dialogs.approvalPanel.headerForWrite')
    case 'Edit':
      return t('tui.dialogs.approvalPanel.headerForEdit')
    case 'TaskStop':
      return t('tui.dialogs.approvalPanel.headerForTaskStop')
    case 'ExitPlanMode':
      return t('tui.dialogs.approvalPanel.headerForExitPlanMode')
    default:
      return t('tui.dialogs.approvalPanel.headerForDefault', { toolName })
  }
}

function renderShellDisplayBlock(
  block: Extract<DisplayBlock, { type: 'shell' }>,
  width: number,
): string[] {
  const lines: string[] = []
  if (block.cwd !== undefined && block.cwd.length > 0) {
    lines.push(t('tui.approvalPanel.shellCwd', { dir: block.cwd }))
  }
  if (block.danger !== undefined) {
    lines.push(t('tui.approvalPanel.shellDangerous', { reason: block.danger }))
  }
  const cmdLines = block.command.length > 0 ? block.command.split('\n') : ['']
  cmdLines.forEach((cmdLine, idx) => {
    const prefix =
      idx === 0
        ? t('tui.approvalPanel.shellPrompt')
        : t('tui.approvalPanel.shellContinuation')
    const wrapped = wrapPlain(cmdLine, Math.max(1, width - prefix.length - 2))
    if (wrapped.length === 0) {
      lines.push(prefix)
      return
    }
    lines.push(`${prefix}${wrapped[0] ?? ''}`)
    for (let i = 1; i < wrapped.length; i++) {
      lines.push(`  ${wrapped[i] ?? ''}`)
    }
  })
  if (block.description !== undefined && block.description.length > 0) {
    lines.push(`  ${block.description}`)
  }
  return lines
}

function renderDisplayBlock(block: DisplayBlock, contentWidth: number): string[] {
  switch (block.type) {
    case 'diff':
      return renderDiffLinesClustered(block.old_text, block.new_text, block.path, {
        contextLines: 3,
        expandKeyHint: t('tui.dialogs.approvalPanel.previewHint'),
        maxLines: DIFF_SUMMARY_MAX_LINES,
      })
    case 'file_content': {
      const lang = block.language ?? langFromPath(block.path)
      const allLines = highlightLines(block.content, lang)
      const shown = allLines.slice(0, CONTENT_SUMMARY_MAX_LINES)
      const lines: string[] = [block.path]
      for (const [i, line] of shown.entries()) {
        lines.push(`${String(i + 1).padStart(4)}  ${line}`)
      }
      const remaining = allLines.length - shown.length
      if (remaining > 0) {
        lines.push(
          `     ${t(
            remaining === 1
              ? 'tui.dialogs.approvalPanel.moreLinesHidden_one'
              : 'tui.dialogs.approvalPanel.moreLinesHidden_other',
            { count: remaining, previewHint: t('tui.dialogs.approvalPanel.previewHint') },
          )}`,
        )
      }
      return lines
    }
    case 'shell':
      return renderShellDisplayBlock(block, contentWidth)
    case 'file_op': {
      const op = block.operation.padEnd(5)
      const lines = [`${op} ${block.path}`]
      if (block.detail !== undefined && block.detail.length > 0) {
        lines.push(block.detail)
      }
      return lines
    }
    case 'url_fetch': {
      const method = (block.method ?? 'GET').toUpperCase().padEnd(5)
      return [`${method} ${block.url}`]
    }
    case 'search': {
      const lines = [`${t('tui.approvalPanel.searchPrefix')} ${block.query}`]
      if (block.scope !== undefined && block.scope.length > 0) {
        lines.push(t('tui.approvalPanel.searchScope', { scope: block.scope }))
      }
      return lines
    }
    case 'invocation': {
      const lines = [`${block.kind.padEnd(5)} ${block.name}`]
      if (block.description !== undefined && block.description.length > 0) {
        lines.push(truncateOneLine(block.description, 200))
      }
      return lines
    }
    case 'brief':
      return block.text ? block.text.split('\n').map((line) => (line.length > 0 ? line : '')) : []
    case 'background_task':
      return [
        t('tui.approvalPanel.backgroundTask', {
          status: block.status,
          kind: block.kind,
          taskId: block.task_id,
          description: block.description,
        }),
      ]
    case 'todo':
      return block.items.map((item) => `- [${item.status}] ${item.title}`)
    default:
      return []
  }
}

function normalizeApprovalText(text: string): string {
  return text.replaceAll('\r\n', '\n').trim()
}

function isDuplicateBriefBlock(block: DisplayBlock, description: string): boolean {
  if (block.type !== 'brief' || block.text.trim().length === 0) return false
  const normalizedDescription = normalizeApprovalText(description)
  if (normalizedDescription.length === 0) return false
  const normalizedBlockText = normalizeApprovalText(block.text)
  if (normalizedBlockText === normalizedDescription) return true
  const blockLines = normalizedBlockText.split('\n')
  if (blockLines.length <= 1) return false
  return normalizeApprovalText(blockLines.slice(1).join('\n')) === normalizedDescription
}

function buildNumericHint(count: number): string {
  if (count <= 0) return '↵'
  return Array.from({ length: Math.min(count, 9) }, (_, idx) => String(idx + 1)).join('/')
}

function findPreviewableBlock(request: PendingApproval): DiffDisplayBlock | FileContentDisplayBlock | undefined {
  for (const block of request.data.display) {
    if (block.type === 'diff' || block.type === 'file_content') return block
  }
  return undefined
}

export interface ApprovalPanelProps {
  readonly request: PendingApproval
  readonly width: number
  readonly onResponse: (response: ApprovalPanelResponse) => void
  readonly onToggleToolOutput?: () => void
  readonly onOpenPreview?: (block: DiffDisplayBlock | FileContentDisplayBlock) => void
}

export const ApprovalPanel: Component<ApprovalPanelProps> = (props) => {
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [feedbackMode, setFeedbackMode] = createSignal(false)
  const [feedback, setFeedback] = createSignal('')

  const choices = (): readonly ApprovalPanelChoice[] => props.request.data.choices
  const choiceCount = (): number => choices().length

  function submit(index: number, withFeedback: string = ''): void {
    const option = choices()[index]
    if (option === undefined) return
    props.onResponse({
      response: option.response,
      feedback: withFeedback.length > 0 ? withFeedback : undefined,
      selected_label: option.selected_label,
    })
  }

  function selectAndSubmit(index: number): void {
    const option = choices()[index]
    if (option === undefined) return
    if (option.requires_feedback === true) {
      setSelectedIndex(index)
      setFeedbackMode(true)
    } else {
      submit(index)
    }
  }

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    if (event.name === 'escape' || (event.ctrl && (event.name === 'c' || event.name === 'd'))) {
      event.stopPropagation()
      props.onResponse({ response: 'rejected' })
      return
    }
    if (event.ctrl && event.name === 'e') {
      const previewable = findPreviewableBlock(props.request)
      if (previewable !== undefined && props.onOpenPreview !== undefined) {
        event.stopPropagation()
        props.onOpenPreview(previewable)
      }
      return
    }
    if (event.ctrl && event.name === 'o') {
      event.stopPropagation()
      props.onToggleToolOutput?.()
      return
    }
    if (feedbackMode()) {
      if (event.name === 'up') {
        event.stopPropagation()
        setFeedbackMode(false)
        setSelectedIndex((i) => (i - 1 + choiceCount()) % choiceCount())
        return
      }
      if (event.name === 'down') {
        event.stopPropagation()
        setFeedbackMode(false)
        setSelectedIndex((i) => (i + 1) % choiceCount())
        return
      }
      if (event.name === 'return' || event.name === 'enter') {
        event.stopPropagation()
        submit(selectedIndex(), feedback())
        return
      }
      if (event.name === 'backspace') {
        setFeedback((f) => f.slice(0, -1))
        return
      }
      const ch = printableChar(event.sequence ?? event.name)
      if (isPrintableChar(ch)) {
        setFeedback((f) => f + ch)
      }
      return
    }
    if (choiceCount() === 0) return
    if (event.name === 'up') {
      setSelectedIndex((i) => (i - 1 + choiceCount()) % choiceCount())
      return
    }
    if (event.name === 'down') {
      setSelectedIndex((i) => (i + 1) % choiceCount())
      return
    }
    if (event.name === 'return' || event.name === 'enter') {
      event.stopPropagation()
      selectAndSubmit(selectedIndex())
      return
    }
    const ch = printableChar(event.sequence ?? event.name)
    const numericIndex = Number(ch) - 1
    if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < choiceCount()) {
      event.stopPropagation()
      selectAndSubmit(numericIndex)
    }
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('borderFocus')
  const titleFg = (): ColorInput => currentTheme.color('borderFocus')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const accentFg = (): ColorInput => currentTheme.color('accent')
  const textStrongFg = (): ColorInput => currentTheme.color('textStrong')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textFg = (): ColorInput => currentTheme.color('text')

  const dedupedBlocks = (): readonly DisplayBlock[] =>
    props.request.data.display.filter(
      (block) => !isDuplicateBriefBlock(block, props.request.data.description),
    )
  const visibleBlocks = (): readonly DisplayBlock[] => dedupedBlocks().slice(0, 5)
  const hasPreviewable = (): boolean =>
    visibleBlocks().some((block) => block.type === 'diff' || block.type === 'file_content')

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box flexDirection="row">
        <Text fg={titleFg()} attributes={titleAttrs()}>{'  ▶ '}</Text>
        <Text fg={titleFg()} attributes={titleAttrs()}>{headerFor(props.request.data.tool_name)}</Text>
      </Box>
      {/* Display blocks / description */}
      <Show when={visibleBlocks().length > 0}>
        <Box>
          <Text>{''}</Text>
        </Box>
        <For each={visibleBlocks()}>
          {(block) => (
            <For each={renderDisplayBlock(block, Math.max(1, props.width - 2))}>
              {(line) => (
                <Box>
                  <Text>{`  ${line}`}</Text>
                </Box>
              )}
            </For>
          )}
        </For>
      </Show>
      <Show when={visibleBlocks().length === 0 && props.request.data.description.length > 0}>
        <Box>
          <Text>{''}</Text>
        </Box>
        <For each={props.request.data.description.split('\n')}>
          {(line) => (
            <Box>
              <Text fg={textDimFg()}>{`  ${line}`}</Text>
            </Box>
          )}
        </For>
      </Show>
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Choices */}
      <For each={choices()}>
        {(option, idx) => {
          const selected = (): boolean => idx() === selectedIndex()
          const num = (): number => idx() + 1
          const labelWithNum = (): string => `${String(num())}. ${option.label}`
          const buttonText = (): string => `[ ${labelWithNum()} ]`
          return (
            <>
              <Show
                when={feedbackMode() && option.requires_feedback === true && selected()}
                fallback={
                  <Box flexDirection="row">
                    <Text fg={selected() ? accentFg() : textFg()}>{`  ${selected() ? '▶ ' : '   '}`}</Text>
                    <Text
                      fg={selected() ? accentFg() : textStrongFg()}
                      attributes={selected() ? currentTheme.attributes('bold') : undefined}
                    >
                      {buttonText()}
                    </Text>
                  </Box>
                }
              >
                <Box flexDirection="row">
                  <Text fg={accentFg()} attributes={currentTheme.attributes('bold')}>{'  ▶ '}</Text>
                  <Text fg={accentFg()} attributes={currentTheme.attributes('bold')}>
                    {labelWithNum()}
                  </Text>
                  <Text>{'  '}</Text>
                  <Text fg={textFg()}>{feedback()}</Text>
                </Box>
              </Show>
              <Show
                when={
                  option.description !== undefined &&
                  option.description.length > 0 &&
                  !(feedbackMode() && option.requires_feedback === true && selected())
                }
              >
                <For each={wrapPlain(option.description ?? '', Math.max(20, props.width - 7))}>
                  {(line) => (
                    <Box>
                      <Text fg={textDimFg()}>{`     ${line}`}</Text>
                    </Box>
                  )}
                </For>
              </Show>
            </>
          )
        }}
      </For>
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Hint */}
      <Show
        when={feedbackMode()}
        fallback={
          <Box>
            <Text fg={textDimFg()}>{`  ${t('tui.dialogs.approvalPanel.navHint', {
              numeric: buildNumericHint(choiceCount()),
              expand: hasPreviewable() ? t('tui.dialogs.approvalPanel.expandHint') : '',
            })}`}</Text>
          </Box>
        }
      >
        <Box>
          <Text fg={textDimFg()}>{`  ${t('tui.dialogs.approvalPanel.feedbackHint')}`}</Text>
        </Box>
      </Show>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}