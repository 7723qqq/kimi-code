/** @jsxImportSource @opentui/solid */
/**
 * TUI2 goal queue manager + edit dialog — opentui + SolidJS edition.
 *
 * Replaces the v1 pi-tui `GoalQueueManagerComponent` /
 * `GoalQueueEditDialogComponent` pair. The manager lists the upcoming
 * goals (navigate / move / edit / delete via keyboard), and the edit
 * dialog provides a multiline objective editor with bracketed-paste
 * sanitization. Behavior mirrors v1 (see
 * `test/tui/components/dialogs/goal-queue-manager.test.ts` for the
 * pinned contract).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import { TextAttributes, type ColorInput, type KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import type { GoalQueueMoveDirection, UpcomingGoal } from '../../goal-queue-store'
import { SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { isPrintableChar, printableChar } from '../../utils/printable-key'

import { Box } from '../common/box'
import { Text } from '../common/text'

export type GoalQueueManagerAction =
  | {
      readonly kind: 'move'
      readonly goalId: string
      readonly direction: GoalQueueMoveDirection
    }
  | { readonly kind: 'edit'; readonly goalId: string }
  | { readonly kind: 'delete'; readonly goalId: string }

export type GoalQueueEditResult =
  | { readonly kind: 'save'; readonly goalId: string; readonly objective: string }
  | { readonly kind: 'cancel'; readonly goalId: string }

export interface GoalQueueManagerDialogProps {
  readonly goals: readonly UpcomingGoal[]
  readonly selectedGoalId?: string
  /** Items per page. Lists longer than this paginate. */
  readonly pageSize?: number
  readonly onAction: (action: GoalQueueManagerAction) => void
  readonly onCancel: () => void
}

export interface GoalQueueEditDialogProps {
  readonly goal: UpcomingGoal
  /** Terminal width in columns; the cursor line windows to it. */
  readonly width?: number
  readonly onDone: (result: GoalQueueEditResult) => void
}

const DEFAULT_PAGE_SIZE = 8
const MAX_GOAL_OBJECTIVE_LENGTH = 4000
const MAX_EDIT_INPUT_LINES = 8
const DEFAULT_WIDTH = 100
const ELLIPSIS = '…'
const BRACKET_PASTE_START = '\u001B[200~'
const BRACKET_PASTE_END = '\u001B[201~'
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// ESC (\x1B) is required to strip terminal control sequences pasted in.
// oxlint-disable-next-line no-control-regex
const ANSI_CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g

export const GoalQueueManagerDialog: Component<GoalQueueManagerDialogProps> = (props) => {
  const initialIndex = (): number => {
    const idx = props.goals.findIndex((goal) => goal.id === props.selectedGoalId)
    return Math.max(idx, 0)
  }
  const [cursor, setCursor] = createSignal(initialIndex())
  const [movingId, setMovingId] = createSignal<string | undefined>(undefined)

  // The host refreshes `goals` after move/delete; keep the cursor and the
  // moving marker valid when the list shrinks.
  createEffect(() => {
    const last = props.goals.length - 1
    if (cursor() > last) setCursor(Math.max(0, last))
    if (movingId() !== undefined && !props.goals.some((goal) => goal.id === movingId())) {
      setMovingId(undefined)
    }
  })

  const pageSize = (): number => props.pageSize ?? DEFAULT_PAGE_SIZE
  const selectedIndex = (): number => Math.min(cursor(), Math.max(0, props.goals.length - 1))
  const selectedGoal = (): UpcomingGoal | undefined => props.goals[selectedIndex()]
  const movingGoalId = (): string | undefined =>
    movingId() !== undefined && props.goals.some((goal) => goal.id === movingId())
      ? movingId()
      : undefined
  const pageStart = (): number => Math.floor(selectedIndex() / pageSize()) * pageSize()
  const pageEnd = (): number => Math.min(pageStart() + pageSize(), props.goals.length)
  const visible = (): readonly UpcomingGoal[] => props.goals.slice(pageStart(), pageEnd())
  const below = (): number => props.goals.length - pageEnd()

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    switch (event.name) {
      case 'escape':
        event.stopPropagation()
        props.onCancel()
        return
      case 'space': {
        const goal = selectedGoal()
        setMovingId((current) => (current === goal?.id ? undefined : goal?.id))
        return
      }
      case 'up': {
        if (movingGoalId() !== undefined && selectedGoal() !== undefined) {
          event.stopPropagation()
          props.onAction({ kind: 'move', goalId: selectedGoal()!.id, direction: 'up' })
          return
        }
        setCursor((c) => Math.max(0, c - 1))
        return
      }
      case 'down': {
        if (movingGoalId() !== undefined && selectedGoal() !== undefined) {
          event.stopPropagation()
          props.onAction({ kind: 'move', goalId: selectedGoal()!.id, direction: 'down' })
          return
        }
        setCursor((c) => Math.min(Math.max(0, props.goals.length - 1), c + 1))
        return
      }
      default:
        break
    }
    const ch = printableChar(event.sequence ?? event.name)
    const goal = selectedGoal()
    if ((ch === 'e' || ch === 'E') && goal !== undefined) {
      event.stopPropagation()
      props.onAction({ kind: 'edit', goalId: goal.id })
      return
    }
    if ((ch === 'd' || ch === 'D') && goal !== undefined) {
      event.stopPropagation()
      props.onAction({ kind: 'delete', goalId: goal.id })
      return
    }
    if (isPrintableChar(ch)) event.stopPropagation()
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const hintFg = (): ColorInput => currentTheme.color('textMuted')
  const textFg = (): ColorInput => currentTheme.color('text')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const successFg = (): ColorInput => currentTheme.color('success')

  const hintText = (): string =>
    movingGoalId() === undefined
      ? t('tui.dialogs.goalQueueManager.navHint')
      : t('tui.dialogs.goalQueueManager.reorderHint')

  function renderGoal(goal: UpcomingGoal, index: number): unknown {
    const isSelected = (): boolean => goal === props.goals[selectedIndex()]
    const isMoving = (): boolean => goal.id === movingGoalId()
    const pointer = (): string => (isSelected() ? SELECT_POINTER : ' ')
    return (
      <Box flexDirection="row">
        <Text fg={isSelected() ? titleFg() : textDimFg()}>{`  ${pointer()} `}</Text>
        <Text fg={isSelected() ? titleFg() : textFg()} attributes={isSelected() ? titleAttrs() : undefined}>
          {`${index + 1}. ${formatListObjective(goal.objective)}`}
        </Text>
        <Show when={isMoving()}>
          <Text fg={successFg()}>{`  ${t('tui.dialogs.goalQueueManager.selected')}`}</Text>
        </Show>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>
          {` ${t('tui.dialogs.goalQueueManager.title')}`}
        </Text>
      </Box>
      {/* Hint */}
      <Box>
        <Text fg={hintFg()}>{` ${hintText()}`}</Text>
      </Box>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Body */}
      <Show
        when={props.goals.length > 0}
        fallback={
          <Box>
            <Text fg={hintFg()}>{`  ${t('tui.dialogs.goalQueueManager.empty')}`}</Text>
          </Box>
        }
      >
        <For each={visible()}>{(goal, i) => renderGoal(goal, pageStart() + i())}</For>
        <Show when={below() > 0}>
          <Box>
            <Text fg={hintFg()}>{` ${t('tui.dialogs.goalQueueManager.more', { count: below() })}`}</Text>
          </Box>
        </Show>
      </Show>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}

export const GoalQueueEditDialog: Component<GoalQueueEditDialogProps> = (props) => {
  const [value, setValue] = createSignal(normalizeNewlines(props.goal.objective))
  const [cursor, setCursor] = createSignal(value().length)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [done, setDone] = createSignal(false)

  function submit(): void {
    const objective = value().trim()
    if (objective.length === 0) {
      setError(t('tui.dialogs.goalQueueEdit.errorEmpty'))
      return
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      setError(t('tui.dialogs.goalQueueEdit.errorTooLong', { max: MAX_GOAL_OBJECTIVE_LENGTH }))
      return
    }
    setDone(true)
    props.onDone({ kind: 'save', goalId: props.goal.id, objective })
  }

  function cancel(): void {
    if (done()) return
    setDone(true)
    props.onDone({ kind: 'cancel', goalId: props.goal.id })
  }

  function insert(text: string): void {
    const normalized = normalizeNewlines(text)
    setValue(value().slice(0, cursor()) + normalized + value().slice(cursor()))
    setCursor((c) => c + normalized.length)
    setError(undefined)
  }

  function insertNewline(): void {
    insert('\n')
  }

  function deleteBeforeCursor(): void {
    if (cursor() === 0) return
    const start = previousGraphemeStart(value(), cursor())
    setValue(value().slice(0, start) + value().slice(cursor()))
    setCursor(start)
    setError(undefined)
  }

  function deleteAfterCursor(): void {
    if (cursor() >= value().length) return
    const end = nextGraphemeEnd(value(), cursor())
    setValue(value().slice(0, cursor()) + value().slice(end))
    setError(undefined)
  }

  function moveVertical(delta: -1 | 1): void {
    const starts = lineStarts(value())
    const location = cursorLocation(value(), cursor(), starts)
    const targetLine = location.line + delta
    if (targetLine < 0 || targetLine >= starts.length) return
    const targetStart = starts[targetLine] ?? 0
    const targetEnd = lineEndForStart(value(), starts, targetLine)
    setCursor(Math.min(targetStart + location.column, targetEnd))
  }

  function handlePasteChunk(data: string): void {
    if (!data.includes(BRACKET_PASTE_START)) return
    const startIndex = data.indexOf(BRACKET_PASTE_START)
    const before = data.slice(0, startIndex)
    if (isPrintableText(before)) insert(before)
    const chunk = data.slice(startIndex + BRACKET_PASTE_START.length)
    const endIndex = chunk.indexOf(BRACKET_PASTE_END)
    const pasted = endIndex === -1 ? chunk : chunk.slice(0, endIndex)
    if (pasted.length > 0) insert(sanitizePastedText(pasted))
  }

  function applyKey(event: KeyEvent): void {
    if (done()) return
    switch (event.name) {
      case 'escape':
        event.stopPropagation()
        cancel()
        return
      case 'c':
        if (event.ctrl) {
          event.stopPropagation()
          cancel()
          return
        }
        break
      case 'd':
        if (event.ctrl) {
          event.stopPropagation()
          cancel()
          return
        }
        break
      case 'return':
      case 'enter':
        if (event.shift) {
          insertNewline()
        } else {
          event.stopPropagation()
          submit()
        }
        return
      case 'j':
        if (event.ctrl) {
          insertNewline()
          return
        }
        break
      case 'backspace':
        deleteBeforeCursor()
        return
      case 'delete':
        deleteAfterCursor()
        return
      case 'left':
        setCursor((c) => previousGraphemeStart(value(), c))
        return
      case 'right':
        setCursor((c) => nextGraphemeEnd(value(), c))
        return
      case 'up':
        moveVertical(-1)
        return
      case 'down':
        moveVertical(1)
        return
      case 'home':
        setCursor((c) => currentLineStart(value(), c))
        return
      case 'a':
        if (event.ctrl) {
          setCursor((c) => currentLineStart(value(), c))
          return
        }
        break
      case 'end':
        setCursor((c) => currentLineEnd(value(), c))
        return
      case 'e':
        if (event.ctrl) {
          setCursor((c) => currentLineEnd(value(), c))
          return
        }
        break
      default:
        break
    }
    if (event.sequence === '\n') {
      insertNewline()
      return
    }
    const ch = printableChar(event.sequence ?? event.name)
    if (isPrintableChar(ch)) {
      insert(ch)
      return
    }
    if (event.sequence !== undefined && event.sequence.includes(BRACKET_PASTE_START)) {
      handlePasteChunk(event.sequence)
    }
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const safeWidth = (): number => Math.max(1, Math.floor(props.width ?? DEFAULT_WIDTH))
  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('textStrong')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const subtitleFg = (): ColorInput =>
    error() === undefined ? currentTheme.color('textDim') : currentTheme.color('warning')
  const footerFg = (): ColorInput => currentTheme.color('textDim')

  const location = createMemo(() => cursorLocation(value(), cursor()))
  const visibleLines = createMemo(() => visibleLineRange(lineStarts(value()).length, location().line))

  function renderInputLine(lineIndex: number): unknown {
    const lines = value().split('\n')
    const line = lines[lineIndex] ?? ''
    const prefix = lineIndex === 0 ? '> ' : '  '
    const isCursorLine = (): boolean => lineIndex === location().line
    const lineWidth = (): number => Math.max(1, Math.floor((safeWidth() - 6) / 2))
    const before = (): string =>
      isCursorLine() ? takeEndByWidth(line.slice(0, location().column), lineWidth()) : ''
    const cursorText = (): string => {
      if (!isCursorLine()) return ''
      const end = nextGraphemeEnd(line, location().column)
      return line.slice(location().column, end) || ' '
    }
    const after = (): string =>
      isCursorLine() ? takeStartByWidth(line.slice(nextGraphemeEnd(line, location().column)), lineWidth()) : ''
    return (
      <Text fg={isCursorLine() ? titleFg() : undefined} wrapMode="none">
        {prefix}
        {isCursorLine() ? before() : ''}
        <Show when={isCursorLine()}>
          <Text attributes={TextAttributes.INVERSE}>{cursorText()}</Text>
        </Show>
        {isCursorLine() ? after() : line}
      </Text>
    )
  }

  return (
    <Box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={borderFg()}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <Text fg={titleFg()} attributes={titleAttrs()}>
        {t('tui.dialogs.goalQueueEdit.title')}
      </Text>
      <Text fg={subtitleFg()}>{error() ?? t('tui.dialogs.goalQueueEdit.subtitle')}</Text>
      <Text>{''}</Text>
      <For each={Array.from({ length: visibleLines().end - visibleLines().start }, (_, i) => visibleLines().start + i)}>
        {renderInputLine}
      </For>
      <Text>{''}</Text>
      <Text fg={footerFg()}>{t('tui.dialogs.goalQueueEdit.footer')}</Text>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Pure helpers (ported from the v1 dialog)
// ---------------------------------------------------------------------------

export function normalizeNewlines(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

export function formatListObjective(objective: string): string {
  return objective.replaceAll(/\s+/g, ' ').trim()
}

export function sanitizePastedText(text: string): string {
  const normalized = normalizeNewlines(text).replaceAll(ANSI_CSI, '')
  let out = ''
  for (let i = 0; i < normalized.length; ) {
    const code = normalized.codePointAt(i)
    if (code === undefined) break
    const char = String.fromCodePoint(code)
    if (char === '\n' || isPrintableText(char)) {
      out += char
    }
    i += code > 0xffff ? 2 : 1
  }
  return out
}

function isPrintableText(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || (code >= 0x7f && code < 0x80)) return false
  }
  return true
}

/** Byte offsets where each line of `text` starts (line 0 starts at 0). */
export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function lineEndForStart(text: string, starts: readonly number[], line: number): number {
  const nextStart = starts[line + 1]
  return nextStart === undefined ? text.length : nextStart - 1
}

/** Line + column (grapheme count) of `offset` within `text`. */
export function cursorLocation(
  text: string,
  offset: number,
  starts: readonly number[] = lineStarts(text),
): { line: number; column: number } {
  let line = 0
  for (let i = 0; i < starts.length; i++) {
    if (offset < (starts[i] ?? 0)) break
    line = i
  }
  return { line, column: offset - (starts[line] ?? 0) }
}

/** Offset of the grapheme before `offset` (0 when at the start). */
export function previousGraphemeStart(text: string, offset: number): number {
  if (offset <= 0) return 0
  let index = 0
  let last = 0
  for (const grapheme of SEGMENTER.segment(text.slice(0, offset))) {
    last = index
    index += grapheme.segment.length
  }
  return last
}

/** Offset of the end of the grapheme at `offset` (offset when at the end). */
export function nextGraphemeEnd(text: string, offset: number): number {
  if (offset >= text.length) return offset
  const first = Array.from(SEGMENTER.segment(text.slice(offset)))[0]
  return first === undefined ? offset : offset + first.segment.length
}

/** Offset of the start of the line containing `offset`. */
function currentLineStart(text: string, offset: number): number {
  const starts = lineStarts(text)
  return starts[cursorLocation(text, offset, starts).line] ?? 0
}

/** Offset just past the last character of the line containing `offset`. */
function currentLineEnd(text: string, offset: number): number {
  const starts = lineStarts(text)
  return lineEndForStart(text, starts, cursorLocation(text, offset, starts).line)
}

/** Window of `MAX_EDIT_INPUT_LINES` line indices around the cursor line. */
export function visibleLineRange(totalLines: number, cursorLine: number): { start: number; end: number } {
  if (totalLines <= MAX_EDIT_INPUT_LINES) return { start: 0, end: totalLines }
  const half = Math.floor(MAX_EDIT_INPUT_LINES / 2)
  const start = Math.max(0, Math.min(cursorLine - half, totalLines - MAX_EDIT_INPUT_LINES))
  return { start, end: start + MAX_EDIT_INPUT_LINES }
}

/** Head of `text` fitting `maxWidth` display cells (grapheme-safe). */
function takeStartByWidth(text: string, maxWidth: number): string {
  let out = ''
  let width = 0
  for (const grapheme of SEGMENTER.segment(text)) {
    const w = Array.from(grapheme.segment).length > 0 ? graphemeWidth(grapheme.segment) : 0
    if (width + w > maxWidth) return out.length > 0 ? out + ELLIPSIS : ''
    out += grapheme.segment
    width += w
  }
  return out
}

/** Tail of `text` fitting `maxWidth` display cells (grapheme-safe). */
function takeEndByWidth(text: string, maxWidth: number): string {
  let out = ''
  let width = 0
  const segments = Array.from(SEGMENTER.segment(text))
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]?.segment ?? ''
    const w = graphemeWidth(segment)
    if (width + w > maxWidth) return out.length > 0 ? ELLIPSIS + out : ''
    out = segment + out
    width += w
  }
  return out
}

function graphemeWidth(text: string): number {
  return Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0) !== undefined && isWide(char) ? 2 : 1), 0)
}

function isWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  )
}