import {
  CLICK_GUARD_MS,
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '#/tui/constant/terminal';
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
  state.editor.terminalFocused = true;
  const disposeInputListener = state.ui.addInputListener((data) =>
    handleTerminalFocusInput(state.terminalState, data, state.editor),
  );
  state.terminal.write(ENABLE_TERMINAL_FOCUS_REPORTING);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    disposeInputListener();
    state.terminal.write(DISABLE_TERMINAL_FOCUS_REPORTING);
    state.terminalState.focused = true;
    state.editor.terminalFocused = true;
  };
}

export function handleTerminalFocusInput(
  state: Pick<TerminalState, 'focused'>,
  data: string,
  editor?: { terminalFocused: boolean },
): { consume: true } | undefined {
  if (data === TERMINAL_FOCUS_IN) {
    state.focused = true;
    if (editor !== undefined) editor.terminalFocused = true;
    return { consume: true };
  }
  if (data === TERMINAL_FOCUS_OUT) {
    state.focused = false;
    if (editor !== undefined) editor.terminalFocused = false;
    return { consume: true };
  }
  return undefined;
}

/** Whether a click lands too soon after a prompt appeared to be deliberate. */
export function isSettlingClick(since: number, now = Date.now()): boolean {
  return now - since < CLICK_GUARD_MS;
}

/**
 * Whether a *confirming keystroke* lands too soon after a prompt appeared.
 *
 * Same window, different hazard. A click fired at whatever was on screen a
 * moment ago cannot reach past `isSettlingClick`. A keystroke is worse: the user
 * was already typing, so the Enter that submits a chat message arrives in the
 * same instant the prompt takes the keyboard and approves on their behalf. That
 * is how an `rm -rf` gets confirmed by someone who never looked at it.
 *
 * Only keys that *commit* an answer consult this. Navigation stays live, so the
 * guard can never make a prompt feel stuck — the user presses Enter again and it
 * goes through.
 */
export function isSettlingKey(since: number, now = Date.now()): boolean {
  return now - since < CLICK_GUARD_MS;
}
