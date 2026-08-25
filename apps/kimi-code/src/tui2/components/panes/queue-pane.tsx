/** @jsxImportSource @opentui/solid */
/**
 * TUI2 queue pane — list of messages queued while the agent is busy
 * (Ctrl-S steer / pending bash / etc.), shown above the editor.
 *
 * Replaces the v1 `QueuePaneComponent` (a pi-tui `Container`) with an
 * opentui SolidJS view. The host feeds `messages`, `isCompacting`, and
 * `isStreaming`; the pane derives the right hint ("Ctrl-S to steer" /
 * "compacting" / "after task") from those flags.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { For, Show } from 'solid-js'

import { t } from '#/i18n'

import { SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import type { ColorInput } from '@opentui/core'
import type { QueuedMessage } from '../../types'

import { Box } from '../common/box'
import { Text } from '../common/text'

const ELLIPSIS = '…'

export interface QueuePaneProps {
  readonly messages: readonly QueuedMessage[]
  readonly isCompacting: boolean
  readonly isStreaming: boolean
  readonly canSteerImmediately: boolean
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text
  return `${text.slice(0, Math.max(1, width - 1))}${ELLIPSIS}`
}

export const QueuePane: Component<QueuePaneProps> = (props) => {
  const hasSteerable = (): boolean => props.messages.some((m) => m.mode !== 'bash')
  const canSteer = (): boolean => props.canSteerImmediately && hasSteerable()
  const hint = (): string => {
    if (props.isCompacting && !props.isStreaming) return t('tui.dialogs.queuePane.hintCompacting')
    if (canSteer()) return t('tui.dialogs.queuePane.hintSteer')
    return t('tui.dialogs.queuePane.hintAfterTask')
  }

  const borderFg = (): ColorInput => currentTheme.color('border')
  const accentFg = (): ColorInput => currentTheme.color('accent')
  const shellFg = (): ColorInput => currentTheme.color('shellMode')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')

  return (
    <Box flexDirection="column">
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      <For each={props.messages}>
        {(item) => {
          const singleLine = (): string => item.text.replaceAll(/\s+/g, ' ').trim()
          return (
            <Show
              when={item.mode === 'bash'}
              fallback={
                <Box flexDirection="row">
                  <Text fg={accentFg()}>{`  ${SELECT_POINTER} `}</Text>
                  <Text>{truncate(singleLine(), 60)}</Text>
                </Box>
              }
            >
              <Box flexDirection="row">
                <Text fg={accentFg()}>{`  ${SELECT_POINTER} `}</Text>
                <Text fg={shellFg()}>{`$ ${truncate(singleLine(), 56)}`}</Text>
              </Box>
            </Show>
          )
        }}
      </For>
      <Show when={props.messages.length > 0}>
        <Box>
          <Text fg={textDimFg()}>{hint()}</Text>
        </Box>
      </Show>
    </Box>
  )
}