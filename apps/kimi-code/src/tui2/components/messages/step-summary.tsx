/** @jsxImportSource @opentui/solid */
/**
 * TUI2 StepSummaryView — collapsed summary of merged steps.
 *
 * Status: REAL (tui2). SolidJS component.
 */

import type { Component } from 'solid-js';
import { Box } from '../common/box';
import { Text } from '../common/text';

export interface StepSummaryProps {
  readonly thinkingCount?: number;
  readonly toolCount?: number;
  readonly messageCount?: number;
}

export const StepSummaryView: Component<StepSummaryProps> = (props) => {
  const parts = () => {
    const list: string[] = [];
    if (props.thinkingCount && props.thinkingCount > 0) {
      list.push(`thinking ${props.thinkingCount} times`);
    }
    if (props.toolCount && props.toolCount > 0) {
      list.push(`call ${props.toolCount} tools`);
    }
    if (props.messageCount && props.messageCount > 0) {
      list.push(`${props.messageCount} messages`);
    }
    return list.join(', ');
  };

  return (
    <Box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <Text fg="#666666">… {parts()}</Text>
    </Box>
  );
};
