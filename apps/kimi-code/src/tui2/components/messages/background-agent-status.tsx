/** @jsxImportSource @opentui/solid */
/**
 * TUI2 background-agent status card.
 *
 * Replaces `tui/components/messages/background-agent-status.ts`'s
 * `BackgroundAgentStatusComponent` (a pi-tui `Component` rendering ANSI
 * strings) with an opentui SolidJS view that renders a
 * `BackgroundAgentStatusData` transcript entry:
 *
 *   ● research agent completed
 *     detail · model · effort
 *
 * Phase → tone mapping mirrors v1: started → `primary`, completed →
 * `success`, everything else (failed / lost / killed / timed_out) →
 * `error`. The `✗` failure mark is used for the failed phase, `●`
 * otherwise; the detail fragment flows dim right after the headline.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'
import { FAILURE_MARK, STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import type { BackgroundAgentStatusData, BackgroundAgentStatusPhase } from '../../types'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface BackgroundAgentStatusViewProps {
  readonly data: BackgroundAgentStatusData
}

/** Phase → tone token mapping, mirrors the v1 component. */
export function backgroundAgentStatusTone(
  phase: BackgroundAgentStatusPhase,
): 'primary' | 'success' | 'error' {
  if (phase === 'started') return 'primary'
  if (phase === 'completed') return 'success'
  return 'error'
}

export const BackgroundAgentStatusView: Component<BackgroundAgentStatusViewProps> = (props) => {
  const tone = (): 'primary' | 'success' | 'error' => backgroundAgentStatusTone(props.data.phase)
  const fg = (): ColorInput => currentTheme.color(tone())
  const bullet = (): string => (props.data.phase === 'failed' ? FAILURE_MARK : STATUS_BULLET)
  const detail = (): string | undefined =>
    props.data.detail !== undefined && props.data.detail.length > 0
      ? t('tui.messages.backgroundAgentStatus.detail', { detail: props.data.detail })
      : undefined

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row">
        <Text fg={fg()}>{bullet()}</Text>
        <Text fg={fg()} wrapMode="word">
          {props.data.headline}
        </Text>
        <Show when={detail() !== undefined}>
          <Text fg={currentTheme.color('textDim')} wrapMode="word">
            {detail()}
          </Text>
        </Show>
      </Box>
    </Box>
  )
}
