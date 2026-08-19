/** @jsxImportSource @opentui/solid */
/**
 * TUI2 effort (thinking) selector — horizontal segmented picker.
 *
 * Replaces the v1 `EffortSelectorComponent` (a pi-tui `Container` subclass)
 * with an opentui SolidJS view. The visual contract mirrors
 * DESIGN.md §8 (the thinking control under `/model`): a single row of
 * segments, the active one wrapped in `[ ]`. ←/→ step the active segment,
 * Enter commits, and Alt+S (when provided) applies session-only.
 *
 * This picker is intentionally not a `ChoicePicker` — it has no vertical
 * list, no search, and ←/→ change selection rather than paging. The state
 * is owned here via a single `activeIndex` signal.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import type { ThinkingEffort } from '@moonshot-ai/kimi-code-sdk'

import { t } from '#/i18n'

import { effortLabel } from './effort-label'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface EffortSelectorProps {
  readonly title?: string
  /** Selectable thinking efforts for the current model. */
  readonly efforts: readonly ThinkingEffort[]
  readonly currentValue: ThinkingEffort
  readonly onSelect: (effort: ThinkingEffort) => void
  /** When provided, Alt+S applies the choice to the current session only. */
  readonly onSessionOnlySelect?: (effort: ThinkingEffort) => void
  readonly onCancel: () => void
  /** Wrapped warning lines rendered directly below the hint (e.g. switch cost). */
  readonly warning?: string
}

export const EffortSelector: Component<EffortSelectorProps> = (props) => {
  const initial = (): number => {
    const idx = props.efforts.indexOf(props.currentValue)
    return Math.max(idx, 0)
  }
  const [active, setActive] = createSignal(initial())

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    switch (event.name) {
      case 'escape':
        event.stopPropagation()
        props.onCancel()
        return
      case 'left':
        setActive((i) => Math.max(0, i - 1))
        return
      case 'right':
        setActive((i) => Math.min(props.efforts.length - 1, i + 1))
        return
      case 'return':
      case 'enter': {
        const effort = props.efforts[active()]
        if (effort !== undefined) {
          event.stopPropagation()
          props.onSelect(effort)
        }
        return
      }
    }
    if (
      event.option &&
      (event.name === 's' || event.name === 'S') &&
      props.onSessionOnlySelect !== undefined
    ) {
      const effort = props.efforts[active()]
      if (effort !== undefined) {
        event.stopPropagation()
        props.onSessionOnlySelect(effort)
      }
    }
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const hintParts = (): readonly string[] => {
    const parts = [
      t('tui.dialogs.effortSelector.hintSwitch'),
      t('tui.dialogs.effortSelector.hintSelect'),
    ]
    if (props.onSessionOnlySelect !== undefined) {
      parts.push(t('tui.dialogs.effortSelector.hintSessionOnly'))
    }
    parts.push(t('tui.dialogs.effortSelector.hintCancel'))
    return parts
  }
  const titleText = (): string =>
    props.title ?? t('tui.dialogs.effortSelector.title')

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const hintFg = (): ColorInput => currentTheme.color('textMuted')
  const warningFg = (): ColorInput => currentTheme.color('warning')
  const segmentFg = (): ColorInput => currentTheme.color('text')

  function renderSegment(effort: ThinkingEffort, index: number): string {
    const label = effortLabel(effort)
    return index === active() ? `[ ${label} ]` : `  ${label}  `
  }
  function segmentColor(index: number): ColorInput {
    return index === active() ? titleFg() : segmentFg()
  }
  function segmentAttrs(index: number): number | undefined {
    return index === active() ? currentTheme.attributes('bold') : undefined
  }

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${titleText()}`}</Text>
      </Box>
      {/* Hint */}
      <Box>
        <Text fg={hintFg()}>{` ${hintParts().join(' · ')}`}</Text>
      </Box>
      {/* Warning (optional) */}
      <Show when={props.warning !== undefined && props.warning.length > 0}>
        <Box>
          <Text fg={warningFg()} wrapMode="word">{` ${props.warning ?? ''}`}</Text>
        </Box>
      </Show>
      {/* Blank line */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Segments */}
      <Box flexDirection="row">
        <Text>{'  '}</Text>
        <For each={props.efforts}>
          {(effort, i) => (
            <Text fg={segmentColor(i())} attributes={segmentAttrs(i())}>
              {renderSegment(effort, i())}
              {i() < props.efforts.length - 1 ? '  ' : ''}
            </Text>
          )}
        </For>
      </Box>
      {/* Blank line */}
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