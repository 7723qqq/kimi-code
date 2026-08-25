/** @jsxImportSource @opentui/solid */
/**
 * TUI2 agent pane — live agent status list (main agent + every running
 * or finished subagent, each with a status icon and a one-line activity
 * detail).
 *
 * Replaces the v1 `AgentPaneComponent` (a pi-tui `Container`) with an
 * opentui SolidJS view. The host aggregates items via `setItems`; the
 * pane is purely presentational.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { For, Show } from 'solid-js'

import { t } from '#/i18n'

import { currentTheme } from '../../theme'
import type { ColorInput } from '@opentui/core'

import { Box } from '../common/box'
import { Text } from '../common/text'

export type AgentStatus = 'active' | 'waiting' | 'done' | 'error'

export interface AgentPaneItem {
  readonly id: string
  readonly name: string
  readonly status: AgentStatus
  readonly detail?: string
}

export interface AgentPaneProps {
  readonly items: readonly AgentPaneItem[]
}

function statusIcon(status: AgentStatus): { glyph: string; fg: () => ColorInput } {
  switch (status) {
    case 'active':
      return { glyph: '●', fg: () => currentTheme.color('accent') }
    case 'waiting':
      return { glyph: '○', fg: () => currentTheme.color('textDim') }
    case 'done':
      return { glyph: '✓', fg: () => currentTheme.color('success') }
    case 'error':
      return { glyph: '✗', fg: () => currentTheme.color('error') }
  }
}

export const AgentPane: Component<AgentPaneProps> = (props) => {
  const borderFg = (): ColorInput => currentTheme.color('border')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const textFg = (): ColorInput => currentTheme.color('text')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  return (
    <Box flexDirection="column">
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` Agents`}</Text>
      </Box>
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      <Show
        when={props.items.length > 0}
        fallback={
          <>
            <Box>
              <Text fg={textMutedFg()}>{`  ${t('tui.panes.agentPane.empty')}`}</Text>
            </Box>
            <Box>
              <Text fg={borderFg()}>─</Text>
            </Box>
          </>
        }
      >
        <For each={props.items}>
          {(item) => {
            const icon = statusIcon(item.status)
            return (
              <>
                <Box flexDirection="row">
                  <Text>{'  '}</Text>
                  <Text fg={icon.fg()}>{icon.glyph}</Text>
                  <Text>{' '}</Text>
                  <Text fg={textFg()}>{item.name}</Text>
                </Box>
                <Show when={item.detail !== undefined && (item.detail ?? '').length > 0}>
                  <Box>
                    <Text fg={textDimFg()}>{`    ${item.detail ?? ''}`}</Text>
                  </Box>
                </Show>
              </>
            )
          }}
        </For>
        <Box>
          <Text fg={borderFg()}>─</Text>
        </Box>
      </Show>
    </Box>
  )
}