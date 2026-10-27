import {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '#/tui/constant/terminal';
import { CLICK_GUARD_MS } from '#/tui/constant/terminal';
import type { TUIState } from '#/tui/tui-state';
import type { TerminalState } from '#/tui/utils/terminal-state';

export {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '#/tui/constant/terminal';

export function installTerminalFocusTracking(state: TUIState): () => void {
  state.terminalState.focused = true;
  const disposeInputListener = state.ui.addInputListener((data) =>
    handleTerminalFocusInput(state.terminalState, data),
  );
  state.terminal.write(ENABLE_TERMINAL_FOCUS_REPORTING);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    disposeInputListener();
    state.terminal.write(DISABLE_TERMINAL_FOCUS_REPORTING);
    state.terminalState.focused = true;
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

/** Whether a click lands too soon after a prompt appeared to be deliberate. */
export function isSettlingClick(since: number, now = Date.now()): boolean {
  return now - since < CLICK_GUARD_MS;
}
