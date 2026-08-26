/** @jsxImportSource @opentui/solid */
/**
 * TUI2 GutterContainer — container reserving left/right padding columns.
 *
 * Status: REAL (tui2). SolidJS component.
 */

import type { Component, JSX } from 'solid-js';
import { Box } from '../common/box';

export interface GutterContainerProps {
  readonly leftPad?: number;
  readonly rightPad?: number;
  readonly children?: JSX.Element;
}

export const GutterContainer: Component<GutterContainerProps> = (props) => {
  return (
    <Box
      flexDirection="column"
      width="100%"
      paddingLeft={props.leftPad ?? 1}
      paddingRight={props.rightPad ?? 1}
    >
      {props.children}
    </Box>
  );
};
