/** @jsxImportSource @opentui/solid */
/**
 * TUI2 ShellRunView — live card for user-initiated shell execution.
 *
 * Status: REAL (tui2). SolidJS component.
 */

import type { Component } from 'solid-js';
import { Show } from 'solid-js';

import { Box } from '../common/box';
import { Text } from '../common/text';

export interface ShellRunProps {
  readonly command: string;
  readonly running?: boolean;
  readonly output?: string;
  readonly exitCode?: number;
  readonly elapsedSec?: number;
}

export const ShellRunView: Component<ShellRunProps> = (props) => {
  const isRunning = () => props.running ?? false;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={isRunning() ? '#4FA8FF' : '#555555'} padding={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text fg="#4FA8FF">! {props.command}</Text>
        <Text fg="#888888">
          {isRunning() ? `(running... ${props.elapsedSec ?? 0}s)` : `[exit: ${props.exitCode ?? 0}]`}
        </Text>
      </Box>
      <Show when={props.output}>
        <Box paddingTop={1}>
          <Text fg="#CCCCCC">{props.output}</Text>
        </Box>
      </Show>
    </Box>
  );
};
