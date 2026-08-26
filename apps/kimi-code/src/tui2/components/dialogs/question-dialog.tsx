/** @jsxImportSource @opentui/solid */
/**
 * TUI2 question dialog — structured question prompt with per-question
 * tabs and a final Submit tab.
 *
 * Replaces the v1 `QuestionDialogComponent` (a pi-tui `Container` with an
 * embedded `Input` for "Other" answers) with an opentui SolidJS view.
 * Each question collects an answer locally (preset option or custom text);
 * the Submit tab reviews every answer before sending. Header / option /
 * multi-select handling mirrors v1.
 *
 * Keyboard: ↑/↓ navigates options, Enter selects (or focuses the "Other"
 * text field), number keys 1-9 shortcut, Tab moves to the next question
 * (or Submit on the last), Ctrl+O toggles tool output (delegated to the
 * host), Esc cancels the whole dialog.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import type {
  PendingQuestion,
  QuestionPanelItem,
  QuestionPanelResponse,
  QuestionSubmissionMethod,
} from '../../reverse-rpc/types'
import { SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { isPrintableChar, printableChar } from '../../utils/printable-key'

import { Box } from '../common/box'
import { Clickable } from '../common/clickable'
import { Text } from '../common/text'

const ELLIPSIS = '…'
const NUMBER_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const
const MAX_BODY_LINES = 12

function _wrapPlain(text: string, width: number): string[] {
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

interface _DisplayOption {
  readonly label: string
  readonly description?: string | undefined
  readonly kind: 'preset' | 'other'
}

export interface QuestionDialogProps {
  readonly request: PendingQuestion
  readonly width: number
  readonly maxVisibleOptions?: number
  readonly onAnswer: (response: QuestionPanelResponse) => void
  /** Ctrl+O: toggle tool output expansion behind the dialog (host-owned). */
  readonly onToggleToolOutput?: () => void
}

export const QuestionDialog: Component<QuestionDialogProps> = (props) => {
  const questions = (): readonly QuestionPanelItem[] => props.request.data.questions
  const questionCount = (): number => questions().length
  const isMultiSelect = (qIdx: number): boolean => questions()[qIdx]?.multi_select === true
  const isOnSubmitTab = (): boolean => currentTab() === questionCount()

  const [currentTab, setCurrentTab] = createSignal(0)
  const [submitActionIdx, setSubmitActionIdx] = createSignal(0)
  const [editingOther, setEditingOther] = createSignal(false)
  const [reviewMessage, setReviewMessage] = createSignal<string | undefined>(undefined)
  const [_lastMethod, setLastMethod] = createSignal<QuestionSubmissionMethod | undefined>(undefined)

  // Per-question cursors + selected indices + "Other" text buffers.
  const [cursors, setCursors] = createSignal<number[]>(questions().map(() => 0))
  const [selections, setSelections] = createSignal<readonly (readonly number[])[]>(
    questions().map<readonly number[]>(() => []),
  )
  const [otherTexts, setOtherTexts] = createSignal<string[]>(questions().map(() => ''))

  function ensureTabInBounds(): void {
    const total = questionCount() + 1
    if (currentTab() >= total) setCurrentTab(total - 1)
  }

  function ensureCursorInBounds(qIdx: number): void {
    const total = optionCount(qIdx)
    if (total === 0) return
    setCursors((prev) => {
      const next = [...prev]
      const current = next[qIdx] ?? 0
      next[qIdx] = Math.max(0, Math.min(current, total - 1))
      return next
    })
  }

  function optionCount(qIdx: number): number {
    return (questions()[qIdx]?.options.length ?? 0) + 1
  }

  function commitOption(qIdx: number, cursorIdx: number): void {
    const opts = questions()[qIdx]?.options ?? []
    const isOther = cursorIdx === opts.length
    if (isOther) {
      setEditingOther(true)
      return
    }
    const opt = opts[cursorIdx]
    if (opt === undefined) return
    if (isMultiSelect(qIdx)) {
      setSelections((prev) => {
        const next = [...prev]
        const current = [...(next[qIdx] ?? [])]
        const idx = current.indexOf(cursorIdx)
        if (idx >= 0) current.splice(idx, 1)
        else current.push(cursorIdx)
        next[qIdx] = current
        return next
      })
    } else {
      setSelections((prev) => {
        const next = [...prev]
        next[qIdx] = [cursorIdx]
        return next
      })
    }
  }

  function _selectSubmitTab(): void {
    ensureTabInBounds()
    setCurrentTab(questionCount())
  }

  function selectNextTab(): void {
    ensureTabInBounds()
    const total = questionCount() + 1
    setCurrentTab((t) => (t + 1) % total)
    setReviewMessage(undefined)
    setSubmitActionIdx(0)
  }
  function selectPrevTab(): void {
    ensureTabInBounds()
    const total = questionCount() + 1
    setCurrentTab((t) => (t - 1 + total) % total)
    setReviewMessage(undefined)
    setSubmitActionIdx(0)
  }

  function submitAll(method: QuestionSubmissionMethod): void {
    const answers = questions().map((question, qIdx) => {
      const selected = selections()[qIdx] ?? []
      const other = otherTexts()[qIdx] ?? ''
      const labels = selected
        .map((idx) => question.options[idx]?.label)
        .filter((label): label is string => label !== undefined)
      const isOtherSelected = selected.includes(question.options.length)
      if (isOtherSelected && other.length > 0) labels.push(other)
      return labels.join(', ')
    })
    if (answers.some((a) => a.length === 0)) {
      setReviewMessage(t('tui.dialogs.questionDialog.unansweredWarning'))
      return
    }
    props.onAnswer({ method, answers })
  }

  function cancel(): void {
    props.onAnswer({ answers: [] })
  }

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    // Edit-other mode swallows printable input and backspace.
    if (editingOther()) {
      const qIdx = currentTab()
      switch (event.name) {
        case 'escape':
          event.stopPropagation()
          setEditingOther(false)
          return
        case 'return':
        case 'enter':
          event.stopPropagation()
          setEditingOther(false)
          commitOption(qIdx, optionCount(qIdx) - 1)
          return
        case 'backspace':
          setOtherTexts((prev) => {
            const next = [...prev]
            next[qIdx] = (next[qIdx] ?? '').slice(0, -1)
            return next
          })
          return
      }
      const ch = printableChar(event.sequence ?? event.name)
      if (isPrintableChar(ch)) {
        setOtherTexts((prev) => {
          const next = [...prev]
          next[qIdx] = (next[qIdx] ?? '') + ch
          return next
        })
      }
      return
    }

    if (event.name === 'escape') {
      event.stopPropagation()
      cancel()
      return
    }
    // v1 also answered empty on Ctrl+C / Ctrl+D (question-dialog.ts:146); the
    // tui2 port only kept Esc, breaking the muscle-memory cancel path.
    if (event.ctrl && (event.name === 'c' || event.name === 'd')) {
      event.stopPropagation()
      cancel()
      return
    }
    if (event.ctrl && event.name === 'o') {
      event.stopPropagation()
      props.onToggleToolOutput?.()
      return
    }
    // ←/→ move between question tabs like Tab/backtab (v1 :183-187).
    if (event.name === 'left') {
      event.stopPropagation()
      selectPrevTab()
      return
    }
    if (event.name === 'right') {
      event.stopPropagation()
      selectNextTab()
      return
    }
    if (event.name === 'tab') {
      event.stopPropagation()
      selectNextTab()
      return
    }
    if (event.name === 'backtab') {
      event.stopPropagation()
      selectPrevTab()
      return
    }

    if (isOnSubmitTab()) {
      if (event.name === 'up' || event.name === 'down') {
        event.stopPropagation()
        setSubmitActionIdx((i) => 1 - i)
        return
      }
      if (event.name === 'return' || event.name === 'enter' || event.name === 'space') {
        event.stopPropagation()
        if (submitActionIdx() === 0) {
          setLastMethod('enter')
          submitAll('enter')
        } else {
          cancel()
        }
        return
      }
      return
    }

    const qIdx = currentTab()
    if (event.name === 'up') {
      setCursors((prev) => {
        const next = [...prev]
        next[qIdx] = Math.max(0, (next[qIdx] ?? 0) - 1)
        return next
      })
      return
    }
    if (event.name === 'down') {
      setCursors((prev) => {
        const next = [...prev]
        next[qIdx] = Math.min(optionCount(qIdx) - 1, (next[qIdx] ?? 0) + 1)
        return next
      })
      return
    }
    if (event.name === 'return' || event.name === 'enter') {
      event.stopPropagation()
      ensureCursorInBounds(qIdx)
      commitOption(qIdx, cursors()[qIdx] ?? 0)
      return
    }
    if (event.name === 'space') {
      event.stopPropagation()
      ensureCursorInBounds(qIdx)
      commitOption(qIdx, cursors()[qIdx] ?? 0)
      return
    }
    const ch = printableChar(event.sequence ?? event.name)
    if (ch.length === 1 && NUMBER_KEYS.includes(ch as (typeof NUMBER_KEYS)[number])) {
      const idx = Number(ch) - 1
      if (idx < optionCount(qIdx)) {
        event.stopPropagation()
        commitOption(qIdx, idx)
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
  const _textFg = (): ColorInput => currentTheme.color('text')
  const _textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const _accentFg = (): ColorInput => currentTheme.color('accent')
  const _successFg = (): ColorInput => currentTheme.color('success')
  const _warningFg = (): ColorInput => currentTheme.color('warning')

  // Tab strip rendering
  const totalTabs = (): number => questionCount() + 1

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Tab strip */}
      <Box flexDirection="row">
        <For each={Array.from({ length: totalTabs() })}>
          {(_, i) => {
            const active = (): boolean => i() === currentTab()
            const label = (): string =>
              i() < questionCount() ? `Q${String(i() + 1)}` : t('tui.dialogs.questionDialog.submitTab')
            return (
              <Clickable onClick={() => setCurrentTab(i())}>
                <Show
                  when={active()}
                  fallback={<Text fg={textMutedFg()}>{` ${label()} `}</Text>}
                >
                  <Text
                    fg={currentTheme.color('primary')}
                    attributes={currentTheme.attributes('bold')}
                  >{` [${label()}] `}</Text>
                </Show>
              </Clickable>
            )
          }}
        </For>
      </Box>
      {/* Title row */}
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.questionDialog.title')}`}</Text>
      </Box>
      {/* Body */}
      <Show when={!isOnSubmitTab()}>
        {(() => {
          const qIdx = currentTab()
          const question = questions()[qIdx]
          if (question === undefined) return null
          const cursorIdx = cursors()[qIdx] ?? 0
          const selected = selections()[qIdx] ?? []
          const otherText = otherTexts()[qIdx] ?? ''
          return (
            <QuestionBody
              question={question}
              qIdx={qIdx}
              cursorIdx={cursorIdx}
              selected={selected}
              otherText={otherText}
              editingOther={editingOther()}
              maxVisibleOptions={props.maxVisibleOptions ?? 6}
              width={props.width}
              onSelectOption={(optIdx) => {
                commitOption(qIdx, optIdx)
              }}
            />
          )
        })()}
      </Show>
      <Show when={isOnSubmitTab()}>
        <SubmitTab
          questions={questions()}
          answers={selections().map((sel, qIdx) => {
            const q = questions()[qIdx]
            if (q === undefined) return ''
            const labels = sel
              .map((idx) => q.options[idx]?.label)
              .filter((l): l is string => l !== undefined)
            if (sel.includes(q.options.length)) {
              const other = otherTexts()[qIdx] ?? ''
              if (other.length > 0) labels.push(other)
            }
            return labels.join(', ')
          })}
          width={props.width}
          submitActionIdx={submitActionIdx()}
          reviewMessage={reviewMessage()}
          onSubmit={() => {
            setLastMethod('enter')
            submitAll('enter')
          }}
          onCancel={cancel}
        />
      </Show>
      {/* Hint */}
      <Box>
        <Text fg={textMutedFg()}>{` ${isOnSubmitTab() ? t('tui.dialogs.questionDialog.submitHint') : t('tui.dialogs.questionDialog.navHint')}`}</Text>
      </Box>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Question body (preset options + Other)
// ---------------------------------------------------------------------------

interface QuestionBodyProps {
  readonly question: QuestionPanelItem
  readonly qIdx: number
  readonly cursorIdx: number
  readonly selected: readonly number[]
  readonly otherText: string
  readonly editingOther: boolean
  readonly maxVisibleOptions: number
  readonly width: number
  readonly onSelectOption: (idx: number) => void
}

const QuestionBody: Component<QuestionBodyProps> = (props) => {
  const textFg = (): ColorInput => currentTheme.color('text')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const accentFg = (): ColorInput => currentTheme.color('accent')
  const successFg = (): ColorInput => currentTheme.color('success')

  const cursorIdx = (): number => props.cursorIdx
  const selected = (): readonly number[] => props.selected

  return (
      <Box flexDirection="column">
        {/* Question header */}
        <Box>
          <Text fg={titleFg()} attributes={titleAttrs()}>{` Q${String(props.qIdx + 1)}. ${props.question.question}`}</Text>
          <Show when={props.question.header !== undefined && (props.question.header ?? '').length > 0}>
            <Text fg={textMutedFg()}>{`  ${props.question.header ?? ''}`}</Text>
          </Show>
        </Box>
        <Show when={props.question.options.length === 0}>
          <Box>
            <Text fg={textMutedFg()}>{`  ${t('tui.dialogs.questionDialog.noOptions')}`}</Text>
          </Box>
        </Show>
        {/* Options */}
        <For each={props.question.options}>
          {(opt, i) => {
            const selectedHere = (): boolean => selected().includes(i())
            return (
              <Clickable onClick={() => props.onSelectOption(i())}>
                <Box flexDirection="row">
                  <Text fg={cursorIdx() === i() ? titleFg() : textDimFg()}>{`  ${cursorIdx() === i() ? SELECT_POINTER : ' '} `}</Text>
                  <Show
                    when={selectedHere()}
                    fallback={<Text fg={textFg()}>{`${String(i() + 1)}. ${opt.label}`}</Text>}
                  >
                    <Text fg={successFg()}>{`${String(i() + 1)}. ${opt.label}`}</Text>
                  </Show>
                  <Show when={opt.description !== undefined && (opt.description ?? '').length > 0}>
                    <Text fg={textMutedFg()}>{`  ${opt.description ?? ''}`}</Text>
                  </Show>
                </Box>
              </Clickable>
            )
          }}
        </For>
        {/* Other option */}
        <Clickable onClick={() => props.onSelectOption(props.question.options.length)}>
          <Box flexDirection="row">
            <Text fg={cursorIdx() === props.question.options.length ? titleFg() : textDimFg()}>{`  ${cursorIdx() === props.question.options.length ? SELECT_POINTER : ' '} `}</Text>
            <Show
              when={props.editingOther}
              fallback={
                <Text fg={textFg()}>{`${String(props.question.options.length + 1)}. ${t('tui.dialogs.questionDialog.defaultOtherLabel')}`}</Text>
              }
            >
              <Text fg={accentFg()}>{`${String(props.question.options.length + 1)}. `}</Text>
              <Text>{props.otherText.length > 0 ? props.otherText : ' '}</Text>
            </Show>
          </Box>
        </Clickable>
      </Box>
    )
}

// ---------------------------------------------------------------------------
// Submit tab (review all answers)
// ---------------------------------------------------------------------------

interface SubmitTabProps {
  readonly questions: readonly QuestionPanelItem[]
  readonly answers: readonly string[]
  readonly width: number
  readonly submitActionIdx: number
  readonly reviewMessage?: string
  readonly onSubmit: () => void
  readonly onCancel: () => void
}

const SubmitTab: Component<SubmitTabProps> = (props) => {
  const textFg = (): ColorInput => currentTheme.color('text')
  const _textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const accentFg = (): ColorInput => currentTheme.color('accent')
  const warningFg = (): ColorInput => currentTheme.color('warning')

  return (
      <Box flexDirection="column">
        <Box>
          <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.questionDialog.reviewTitle')}`}</Text>
        </Box>
        <For each={props.questions}>
          {(q, i) => {
            const answer = (): string => props.answers[i()] ?? ''
            return (
              <Box flexDirection="row">
                <Text>{`  Q${String(i() + 1)}: `}</Text>
                <Show
                  when={answer().length > 0}
                  fallback={<Text fg={textMutedFg()}>{t('tui.dialogs.questionDialog.notAnswered')}</Text>}
                >
                  <Text fg={textFg()}>{answer()}</Text>
                </Show>
              </Box>
            )
          }}
        </For>
        <Box>
          <Text>{''}</Text>
        </Box>
        {/* Submit / cancel actions */}
        <Box flexDirection="row" gap={2}>
          <Clickable onClick={props.onSubmit}>
            <Text
              fg={props.submitActionIdx === 0 ? accentFg() : textFg()}
              attributes={props.submitActionIdx === 0 ? titleAttrs() : undefined}
            >
              {`  [ ${t('common.submit')} ]`}
            </Text>
          </Clickable>
          <Clickable onClick={props.onCancel}>
            <Text
              fg={props.submitActionIdx === 1 ? accentFg() : textFg()}
              attributes={props.submitActionIdx === 1 ? titleAttrs() : undefined}
            >
              {`[ ${t('common.cancel')} ]`}
            </Text>
          </Clickable>
        </Box>
        <Show when={props.reviewMessage !== undefined && (props.reviewMessage ?? '').length > 0}>
          <Box>
            <Text fg={warningFg()}>{`  ${props.reviewMessage ?? ''}`}</Text>
          </Box>
        </Show>
      </Box>
    )
}

// Touch unused locals to satisfy lint.
void MAX_BODY_LINES
void NUMBER_KEYS