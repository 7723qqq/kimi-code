/** @jsxImportSource @opentui/solid */
/**
 * TUI2 approval preview viewer — full-screen preview of an Edit diff or
 * Write file content for the approval flow.
 *
 * Replaces the v1 `ApprovalPreviewViewer` (a pi-tui `Container`) with an
 * opentui SolidJS view. The viewer is a snapshot: lines are rendered once
 * at construction and only sliced on scroll, keeping per-frame render cost
 * in O(viewport) even for very large diffs.
 *
 * Keyboard: ↑/↓ scroll line, PgUp/PgDn page, Home/End top/bottom, Esc /
 * Ctrl+E / q closes. The host mounts the viewer via the takeover pattern
 * and tears it down when the user resolves the approval.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import { highlightLines, langFromPath } from '../../../tui/components/media/code-highlight'
import { renderDiffLinesClustered } from '../../../tui/components/media/diff-preview'
import type {
  DiffDisplayBlock,
  FileContentDisplayBlock,
} from '../../reverse-rpc/types'
import { currentTheme } from '../../theme'
import { isPrintableChar, printableChar } from '../../utils/printable-key'

import { Box } from '../common/box'
import { Text } from '../common/text'

const ELLIPSIS = '…'

export type ApprovalPreviewBlock = DiffDisplayBlock | FileContentDisplayBlock

export interface ApprovalPreviewViewerProps {
  readonly block: ApprovalPreviewBlock
  /** Total viewport rows available for body content. */
  readonly viewRows: number
  /** Terminal width in columns. */
  readonly width: number
  readonly onClose: () => void
}

interface BuiltBody {
  lines: readonly string[]
  title: string
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

function buildBody(block: ApprovalPreviewBlock): BuiltBody {
  if (block.type === 'diff') return buildDiffBody(block)
  return buildFileContentBody(block)
}

function buildDiffBody(block: DiffDisplayBlock): BuiltBody {
  const rendered = renderDiffLinesClustered(block.old_text, block.new_text, block.path, {
    contextLines: 3,
    oldStart: block.old_start ?? 1,
    newStart: block.new_start ?? 1,
  })
  const [header = '', ...rest] = rendered
  return { lines: rest, title: stripLeadingSpace(header) }
}

function buildFileContentBody(block: FileContentDisplayBlock): BuiltBody {
  const lang = block.language ?? langFromPath(block.path)
  const highlighted = highlightLines(block.content, lang)
  const lines = highlighted.map(
    (line, i) => `${String(i + 1).padStart(4)}  ${line}`,
  )
  return { lines, title: block.path }
}

function stripLeadingSpace(s: string): string {
  return s.replace(/^ +/, '')
}

export const ApprovalPreviewViewer: Component<ApprovalPreviewViewerProps> = (props) => {
  const [scrollTop, setScrollTop] = createSignal(0)

  const built = (): BuiltBody => buildBody(props.block)
  const bodyLines = (): readonly string[] => built().lines
  const innerWidth = (): number => Math.max(1, props.width - 4)
  const viewRows = (): number => Math.max(1, props.viewRows - 2)
  const maxScroll = (): number => Math.max(0, bodyLines().length - viewRows())

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    if (event.name === 'escape' || event.ctrl && event.name === 'e') {
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
    if (event.name === 'pageup') {
      setScrollTop((t) => Math.max(0, t - Math.max(1, viewRows() - 1)))
      return
    }
    if (event.name === 'pagedown') {
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
    if (isPrintableChar(ch)) {
      // printable but not bound → ignore
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
        <Text fg={titleFg()} attributes={titleAttrs()}>
          {` ${t('tui.dialogs.approvalPreview.title')} `}
        </Text>
        <Text fg={textMutedFg()}>{built().title}</Text>
      </Box>
      {/* Body */}
      <Box>
        <Text fg={borderFg()}>{`┌${'─'.repeat(Math.max(0, props.width - 2))}┐`}</Text>
      </Box>
      <For each={Array.from({ length: viewRows() })}>
        {(_, i) => {
          const lineIndex = (): number => scrollTop() + i()
          const raw = (): string => bodyLines()[lineIndex()] ?? ''
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
        <Text>{` ${t('tui.dialogs.approvalPreview.footerKeys')}`}</Text>
        <Text>{''}</Text>
        <Text fg={textMutedFg()}>
          {` ${(scrollTop() + 1)}-${Math.min(bodyLines().length, scrollTop() + viewRows())} / ${bodyLines().length} `}
        </Text>
      </Box>
    </Box>
  )
}