/** @jsxImportSource @opentui/solid */
/**
 * TUI2 Agent Swarm summary view.
 *
 * Reads `AgentSwarmProgressData` (the per-entry summary published by
 * `controllers/subagent-event-handler.ts` `publishSwarmProgress`) and
 * renders it as a small status card above the corresponding
 * `ToolCallView`. The per-member grid in v1's
 * `AgentSwarmProgressComponent` is out of scope — the published summary
 * is what the model core exposes, and v1's grid depended on a member
 * registry that this branch does not yet maintain. Only counters and
 * status are rendered here; cancellation surfaces through the same
 * `cancelled` status the core writes when the host aborts an in-flight
 * turn (`controllers/session-event-handler.ts markActiveAgentSwarmsCancelled`).
 *
 * Status: REAL (tui2). Closes the residual gap noted in
 * `plan/tui2-full-replacement.md` ("swarm 取消/进度渲染集成").
 */

import type { Component } from 'solid-js'
import { Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'

import { FAILURE_MARK, STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import type { AgentSwarmProgressData } from '../../types'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface AgentSwarmProgressViewProps {
  readonly data: AgentSwarmProgressData
}

type SwarmsStatusTone = 'primary' | 'success' | 'warning' | 'error'

export function swarmStatusTone(status: AgentSwarmProgressData['status']): SwarmsStatusTone {
  if (status === 'cancelled') return 'warning'
  if (status === 'ended') return 'success'
  return 'primary'
}

export function swarmStatusLabel(status: AgentSwarmProgressData['status']): string {
  if (status === 'cancelled') return t('tui.messages.agentSwarmProgress.cancelled')
  if (status === 'ended') return t('tui.messages.agentSwarmProgress.completed')
  if (status === 'running') return t('tui.messages.agentSwarmProgress.working')
  return t('tui.messages.agentSwarmProgress.orchestrating')
}

export const AgentSwarmProgressView: Component<AgentSwarmProgressViewProps> = (props) => {
  const tone = (): SwarmsStatusTone => swarmStatusTone(props.data.status)
  const fg = (): ColorInput => currentTheme.color(tone())
  const bullet = (): string =>
    tone() === 'warning' || tone() === 'error' ? FAILURE_MARK : STATUS_BULLET

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row">
        <Text fg={fg()}>{bullet()}</Text>
        <Text fg={fg()} wrapMode="word">
          {t('tui.messages.agentSwarmProgress.title')}
        </Text>
        <Show when={props.data.description.length > 0}>
          <Text fg={currentTheme.color('textDim')} wrapMode="word">
            {' — '}
            {props.data.description}
          </Text>
        </Show>
      </Box>
      <Box flexDirection="row" paddingLeft={2}>
        <Text fg={fg()} wrapMode="word">
          {swarmStatusLabel(props.data.status)}
          {' · '}
          {t('tui.messages.agentSwarmProgress.membersCount', {
            completed: props.data.completedCount,
            total: props.data.memberCount,
          })}
          <Show when={props.data.failedCount > 0}>
            {' · '}
            <Text fg={currentTheme.color('error')}>
              {t('tui.messages.agentSwarmProgress.failedCount', {
                count: props.data.failedCount,
              })}
            </Text>
          </Show>
        </Text>
      </Box>
    </Box>
  )
}
