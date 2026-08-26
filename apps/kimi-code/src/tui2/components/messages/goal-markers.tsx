/** @jsxImportSource @opentui/solid */
/**
 * TUI2 GoalMarker — low-profile transcript marker for the autonomous goal loop.
 *
 * Status: REAL (tui2). SolidJS component.
 */

import type { Component } from 'solid-js';
import { Show } from 'solid-js';

import { Box } from '../common/box';
import { Text } from '../common/text';

export interface GoalMarkerProps {
  readonly headline: string;
  readonly detail?: string;
  readonly marker?: string;
  readonly accentColor?: string;
  readonly textColor?: string;
}

export const GoalMarkerView: Component<GoalMarkerProps> = (props) => {
  const marker = () => props.marker ?? '◦';
  const accent = () => props.accentColor ?? '#888888';
  const textFg = () => props.textColor ?? '#AAAAAA';

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Box flexDirection="row">
        <Text fg={accent()}>{marker()} </Text>
        <Text fg={textFg()}>{props.headline}</Text>
      </Box>
      <Show when={props.detail}>
        <Box paddingLeft={2}>
          <Text fg="#666666">{props.detail}</Text>
        </Box>
      </Show>
    </Box>
  );
};
