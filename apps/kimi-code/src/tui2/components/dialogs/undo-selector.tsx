/** @jsxImportSource @opentui/solid */
/**
 * TUI2 undo selector — list of recent user messages to undo back to.
 *
 * Replaces the v1 `UndoSelectorComponent` (a pi-tui `Container` subclass
 * built on `SearchableList`) with an opentui SolidJS view. The picker
 * walks a windowed slice of the choices so the cursor lands at
 * `PREFERRED_SELECTED_OFFSET` rows from the top — matching the v1 layout.
 * Items past the cursor (the "undo range") are tinted dim.
 *
 * The picker owns a single `cursor` signal and consumes key events via
 * `useKeyboard`. Mouse click hit-testing is intentionally omitted (the
 * v1 keyboard contract covers the primary flow; click can be added when
 * the tui2 host grows a focused-click pipeline).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import { getCurrentMark, SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { isPrintableChar, printableChar } from '../../utils/printable-key'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface UndoChoice {
  readonly id: string
  readonly count: number
  readonly input: string
  readonly label: string
}

export interface UndoSelectorProps {
  readonly choices: readonly UndoChoice[]
  readonly onSelect: (choice: UndoChoice) => void
  readonly onCancel: () => void
}

const MAX_VISIBLE_CHOICES = 5
const PREFERRED_SELECTED_OFFSET = 2

export const UndoSelector: Component<UndoSelectorProps> = (props) => {
  const [cursor, setCursor] = createSignal(Math.max(0, props.choices.length - 1))

  const windowStart = createMemo(() => {
    const len = props.choices.length
    if (len === 0) return 0
    const visibleCount = Math.min(MAX_VISIBLE_CHOICES, len)
    const maxStart = len - visibleCount
    return Math.min(Math.max(0, cursor() - PREFERRED_SELECTED_OFFSET), maxStart)
  })
  const windowEnd = createMemo(() => Math.min(windowStart() + MAX_VISIBLE_CHOICES, props.choices.length))
  const visible = createMemo(() => props.choices.slice(windowStart(), windowEnd()))
  const selectedChoice = createMemo<UndoChoice | undefined>(() => props.choices[cursor()])

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    switch (event.name) {
      case 'escape':
        event.stopPropagation()
        props.onCancel()
        return
      case 'up':
        setCursor((c) => Math.max(0, c - 1))
        return
      case 'down':
        setCursor((c) => Math.min(Math.max(0, props.choices.length - 1), c + 1))
        return
      case 'return':
      case 'enter': {
        const choice = selectedChoice()
        if (choice !== undefined) {
          event.stopPropagation()
          props.onSelect(choice)
        }
        return
      }
      default:
        break
    }
    // Backspace or any printable: no-op here (undo selector isn't searchable).
    if (event.name === 'backspace') return
    const ch = printableChar(event.sequence ?? event.name)
    if (isPrintableChar(ch)) return
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const hintFg = (): ColorInput => currentTheme.color('textMuted')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textFg = (): ColorInput => currentTheme.color('text')

  function lineColor(choice: UndoChoice, isSelected: boolean): ColorInput {
    if (isSelected) return titleFg()
    // Items past the cursor (the undo range) read as textDim; earlier
    // items as text. Mirrors v1's `inUndoRange` branch.
    const idx = props.choices.indexOf(choice)
    return idx > cursor() ? textDimFg() : textFg()
  }
  function labelAttrs(isSelected: boolean): number | undefined {
    return isSelected ? currentTheme.attributes('bold') : undefined
  }

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.undoSelector.title')}`}</Text>
      </Box>
      {/* Hint */}
      <Box>
        <Text fg={hintFg()}>{` ${t('tui.dialogs.undoSelector.navHint')}`}</Text>
      </Box>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Body */}
      <Show
        when={props.choices.length > 0}
        fallback={
          <Box>
            <Text fg={hintFg()}>{t('tui.dialogs.undoSelector.noMessages')}</Text>
          </Box>
        }
      >
        <For each={visible()}>
          {(choice) => {
            const isSelected = (): boolean => choice === selectedChoice()
            const pointer = (): string => (isSelected() ? SELECT_POINTER : ' ')
            return (
              <Box flexDirection="row">
                <Text fg={isSelected() ? titleFg() : textDimFg()}>{`  ${pointer()} `}</Text>
                <Text fg={lineColor(choice, isSelected())} attributes={labelAttrs(isSelected())}>
                  {choice.label}
                </Text>
                <Show when={isSelected()}>
                  <Text>{` ${getCurrentMark()}`}</Text>
                </Show>
              </Box>
            )
          }}
        </For>
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