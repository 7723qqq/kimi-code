/** @jsxImportSource @opentui/solid */
/**
 * TUI2 swarm mode marker view.
 *
 * Replaces `tui/components/messages/swarm-markers.ts`'s
 * `SwarmModeMarkerComponent`. Renders the `✦` bullet + label for swarm
 * mode entry/exit, colored by state.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

import { t } from '#/i18n'
import { STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

export type SwarmModeMarkerState = 'active' | 'inactive' | 'ended';

export interface SwarmModeMarkerViewProps {
  readonly state: SwarmModeMarkerState
}

function swarmMarkerLabel(state: SwarmModeMarkerState): string {
  switch (state) {
    case 'active':
      return t('tui.messages.swarmMarkers.activated')
    case 'inactive':
      return t('tui.messages.swarmMarkers.deactivated')
    case 'ended':
      return t('tui.messages.swarmMarkers.ended')
  }
}

export const SwarmModeMarkerView: Component<SwarmModeMarkerViewProps> = (props) => {
  const token = (): 'textDim' | 'success' => (props.state === 'inactive' ? 'textDim' : 'success')
  return (
    <Box flexDirection="row" paddingLeft={2}>
      <Text fg={currentTheme.color(token())} attributes={currentTheme.attributes('bold')}>
        {STATUS_BULLET}
      </Text>
      <Text fg={currentTheme.color(token())} attributes={currentTheme.attributes('bold')}>
        {swarmMarkerLabel(props.state)}
      </Text>
    </Box>
  )
}
