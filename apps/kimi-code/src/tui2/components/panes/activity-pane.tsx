/** @jsxImportSource @opentui/solid */
/**
 * TUI2 activity pane — small spinner + tip line shown in the right pane
 * during waiting / thinking / composing / tool execution.
 *
 * Replaces the v1 `ActivityPaneComponent` (a pi-tui `Container` with an
 * embedded `MoonLoader`) with an opentui SolidJS view. The spinner runs
 * locally via `createSignal` + `setInterval` (no external dependency on
 * the v1 `MoonLoader`); the lifecycle is owned by the host — mount the
 * pane while a phase is active, unmount it when the phase ends.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createEffect, createSignal, onCleanup, Show } from 'solid-js'

import { t } from '#/i18n'

import { ACTIVITY_DETAIL_INDENT } from '../../constant/rendering'
import { BRAILLE_SPINNER_FRAMES, BRAILLE_SPINNER_INTERVAL_MS } from '../../constant/rendering'
import { currentTheme } from '../../theme'
import type { ColorInput } from '@opentui/core'

import { Box } from '../common/box'
import { Text } from '../common/text'

export type ActivityPaneMode = 'hidden' | 'waiting' | 'thinking' | 'composing' | 'tool'

export interface ActivityPaneProps {
  readonly mode: ActivityPaneMode
  readonly tip?: string
  readonly detail?: string
}

function ActivitySpinner(): unknown {
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    const id = setInterval(
      () => setFrame((f) => (f + 1) % BRAILLE_SPINNER_FRAMES.length),
      BRAILLE_SPINNER_INTERVAL_MS,
    )
    onCleanup(() => clearInterval(id))
  })
  const fg = (): ColorInput => currentTheme.color('textDim')
  return (
    <Text fg={fg()}>{`${BRAILLE_SPINNER_FRAMES[frame()] ?? BRAILLE_SPINNER_FRAMES[0]} `}</Text>
  )
}

export const ActivityPane: Component<ActivityPaneProps> = (props) => {
  const tipText = (): string => {
    if (props.tip === undefined || props.tip.length === 0) return ''
    return ` · ${t('tui.chrome.activityPane.tipPrefix', { tip: props.tip })}`
  }
  const isActive = (): boolean =>
    props.mode === 'waiting' || props.mode === 'tool' || props.mode === 'composing'
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  return (
    <Show when={isActive()}>
      <Box flexDirection="column">
        <Box>
          <Text>{''}</Text>
        </Box>
        <Box flexDirection="row">
          <ActivitySpinner />
          <Text fg={textDimFg()}>{tipText()}</Text>
        </Box>
        <Show when={props.detail !== undefined && (props.detail ?? '').length > 0}>
          <Box>
            <Text fg={textDimFg()}>{`${ACTIVITY_DETAIL_INDENT}${props.detail ?? ''}`}</Text>
          </Box>
        </Show>
      </Box>
    </Show>
  )
}