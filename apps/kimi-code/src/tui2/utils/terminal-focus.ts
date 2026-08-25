/**
 * TUI2 terminal focus tracking — xterm focus-reporting sequences.
 *
 * Mirrors `tui/utils/terminal-focus.ts` with the pi-tui `TUIState` host
 * swapped for a minimal abstract host (`onRawInput` + `write`), so the
 * tui2 shell can wire it to opentui's raw input stream.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '../constant/terminal';
import type { TerminalState } from './terminal-state';

export {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '../constant/terminal';

/** The slice of the shell the focus tracker needs. */
export interface TerminalFocusHost {
  readonly terminalState: TerminalState;
  /** Register a raw input listener; returns an unsubscribe function. */
  onRawInput(listener: (data: string) => void): () => void;
  /** Write bytes to the terminal. */
  write(data: string): void;
}

export function installTerminalFocusTracking(host: TerminalFocusHost): () => void {
  host.terminalState.focused = true;
  const disposeInputListener = host.onRawInput((data) =>
    handleTerminalFocusInput(host.terminalState, data),
  );
  host.write(ENABLE_TERMINAL_FOCUS_REPORTING);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    disposeInputListener();
    host.write(DISABLE_TERMINAL_FOCUS_REPORTING);
    host.terminalState.focused = true;
  };
}

export function handleTerminalFocusInput(
  state: Pick<TerminalState, 'focused'>,
  data: string,
): { consume: true } | undefined {
  if (data === TERMINAL_FOCUS_IN) {
    state.focused = true;
    return { consume: true };
  }
  if (data === TERMINAL_FOCUS_OUT) {
    state.focused = false;
    return { consume: true };
  }
  return undefined;
}
