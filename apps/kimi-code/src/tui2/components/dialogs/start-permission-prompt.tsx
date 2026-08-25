/** @jsxImportSource @opentui/solid */
/**
 * TUI2 start-permission prompt — notice + selectable options.
 *
 * Replaces the v1 `StartPermissionPromptComponent` (a pi-tui `Component`)
 * with an opentui SolidJS view. The dialog shows a title, a hint, an
 * optional notice block, then a vertical list of options with wrap-aware
 * descriptions. ↑/↓ moves the cursor; Enter (or Space) commits; Esc cancels.
 *
 * This is the base class for `GoalStartPermissionPrompt` and
 * `SwarmStartPermissionPrompt` in v1; in tui2 the wrappers become thin
 * SolidJS components that compose this view with their specific options.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import { createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import { SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

export type StartPermissionChoice = 'auto' | 'yolo' | 'manual' | 'cancel'

export interface StartPermissionOption<
  TChoice extends StartPermissionChoice = StartPermissionChoice,
> {
  readonly value: TChoice
  readonly label: string
  readonly description: string
}

export interface StartPermissionPromptProps<TChoice extends StartPermissionChoice> {
  readonly title: string
  readonly noticeLines: readonly string[]
  readonly options: readonly StartPermissionOption<TChoice>[]
  readonly onSelect: (choice: TChoice) => void
  readonly onCancel: () => void
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
    current = word.length <= safeWidth ? word : `${word.slice(0, Math.max(1, safeWidth - 1))}…`
  }
  if (current.length > 0) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/**
 * Highlight the words `Manual` / `Auto` / `YOLO` with `textStrong` so they
 * pop against the muted notice text. Mirrors v1's `styleModeNames`.
 */
function highlightModeNames(text: string, baseToken: () => ColorInput): unknown {
  const parts = text.split(/(\b(?:Manual|Auto|YOLO)\b)/g)
  return (
    <For each={parts}>
      {(part) => {
        if (part === 'Manual' || part === 'Auto' || part === 'YOLO') {
          return (
            <Text fg={currentTheme.color('textStrong')} attributes={currentTheme.attributes('bold')}>
              {part}
            </Text>
          )
        }
        return <Text fg={baseToken()}>{part}</Text>
      }}
    </For>
  )
}

export function StartPermissionPrompt<TChoice extends StartPermissionChoice>(
  props: StartPermissionPromptProps<TChoice>,
): unknown {
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    switch (event.name) {
      case 'escape':
        event.stopPropagation()
        props.onCancel()
        return
      case 'up':
        setSelectedIndex((i) => Math.max(0, i - 1))
        return
      case 'down':
        setSelectedIndex((i) => Math.min(props.options.length - 1, i + 1))
        return
      case 'return':
      case 'enter':
      case 'space':
        event.stopPropagation()
        {
          const choice = props.options[selectedIndex()]
          if (choice !== undefined) props.onSelect(choice.value)
        }
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
  const textFg = (): ColorInput => currentTheme.color('text')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${props.title}`}</Text>
      </Box>
      {/* Hint */}
      <Box>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.startPermissionPrompt.navHint')}`}</Text>
      </Box>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Notice */}
      <For each={props.noticeLines}>
        {(paragraph) => (
          <For each={wrapPlain(paragraph, 80)}>
            {(line) => (
              <Box>
                <Text fg={textMutedFg()}>{' '}</Text>
                {highlightModeNames(line, () => textMutedFg())}
              </Box>
            )}
          </For>
        )}
      </For>
      {/* Options */}
      <For each={props.options}>
        {(option, i) => {
          const selected = (): boolean => i() === selectedIndex()
          return (
            <>
              <Box flexDirection="row">
                <Text fg={selected() ? titleFg() : textDimFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
                <Text
                  fg={selected() ? titleFg() : textFg()}
                  attributes={selected() ? titleAttrs() : undefined}
                >
                  {option.label}
                </Text>
              </Box>
              <For each={wrapPlain(option.description, 76)}>
                {(line) => (
                  <Box>
                    <Text fg={textMutedFg()}>{`    ${line}`}</Text>
                  </Box>
                )}
              </For>
              {/* Blank between options */}
              <Show when={i() < props.options.length - 1}>
                <Box>
                  <Text>{''}</Text>
                </Box>
              </Show>
            </>
          )
        }}
      </For>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}