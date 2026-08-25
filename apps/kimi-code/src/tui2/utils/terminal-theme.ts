/**
 * TUI2 terminal theme tracking — OSC 11 background + xterm theme reports.
 *
 * Mirrors `tui/utils/terminal-theme.ts` with the pi-tui `TUIState` host
 * swapped for a minimal abstract host (`onRawInput` + `write`), so the tui2
 * shell can wire it to opentui's raw input stream.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import {
  DISABLE_TERMINAL_THEME_REPORTING,
  ENABLE_TERMINAL_THEME_REPORTING,
  OSC11_QUERY,
  OSC11_RESPONSE,
  OSC11_RESPONSE_PREFIX,
  OSC11_RESPONSE_PREFIX_NO_ESC,
  QUERY_TERMINAL_THEME,
  TERMINAL_THEME_INPUT_BUFFER_MAX_LENGTH,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
} from '../constant/terminal';
import type { ResolvedTheme } from '../theme/colors';
import { parseOsc11BackgroundTheme } from '../theme/terminal-background';

export {
  DISABLE_TERMINAL_THEME_REPORTING,
  ENABLE_TERMINAL_THEME_REPORTING,
  OSC11_QUERY,
  QUERY_TERMINAL_THEME,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
} from '../constant/terminal';

export function hasTerminalThemeReport(data: string): boolean {
  return data.includes(TERMINAL_THEME_DARK) || data.includes(TERMINAL_THEME_LIGHT);
}

export interface TerminalThemeInputState {
  osc11Buffer: string;
}

export type TerminalThemeInputResult =
  | {
      consume?: boolean;
      data?: string;
    }
  | undefined;

export function createTerminalThemeInputState(): TerminalThemeInputState {
  return { osc11Buffer: '' };
}

export function handleTerminalThemeInput(
  data: string,
  write: (data: string) => void,
  onTheme: (theme: ResolvedTheme) => void,
  inputState: TerminalThemeInputState = createTerminalThemeInputState(),
): TerminalThemeInputResult {
  let remaining = data;

  if (inputState.osc11Buffer !== '') {
    const candidate = `${inputState.osc11Buffer}${data}`;
    const stripped = stripOsc11Reports(candidate, onTheme);
    if (stripped !== candidate) {
      inputState.osc11Buffer = '';
      return resultFromRemaining(stripped);
    }

    inputState.osc11Buffer =
      candidate.length > TERMINAL_THEME_INPUT_BUFFER_MAX_LENGTH ? '' : candidate;
    return { consume: true };
  }

  remaining = stripOsc11Reports(remaining, onTheme);
  remaining = stripTerminalThemeReports(remaining, write);

  const partialOsc11Start = findPartialOsc11Start(remaining);
  if (partialOsc11Start !== -1) {
    inputState.osc11Buffer = remaining.slice(partialOsc11Start);
    return resultFromRemaining(remaining.slice(0, partialOsc11Start));
  }

  if (remaining !== data) return resultFromRemaining(remaining);

  return undefined;
}

function stripOsc11Reports(data: string, onTheme: (theme: ResolvedTheme) => void): string {
  let remaining = data;

  for (;;) {
    const match = OSC11_RESPONSE.exec(remaining);
    if (match === null) return remaining;

    const theme = parseOsc11BackgroundTheme(match[0]);
    if (theme !== null) onTheme(theme);

    remaining = `${remaining.slice(0, match.index)}${remaining.slice(match.index + match[0].length)}`;
  }
}

function stripTerminalThemeReports(data: string, write: (data: string) => void): string {
  let remaining = data;
  let strippedReport = false;

  for (const report of [TERMINAL_THEME_DARK, TERMINAL_THEME_LIGHT]) {
    if (!remaining.includes(report)) continue;
    remaining = remaining.split(report).join('');
    strippedReport = true;
  }

  if (strippedReport) {
    write(OSC11_QUERY);
  }

  return remaining;
}

function findPartialOsc11Start(data: string): number {
  const fullPrefixIndex = data.indexOf(OSC11_RESPONSE_PREFIX);
  if (fullPrefixIndex !== -1) return fullPrefixIndex;

  const noEscPrefixIndex = data.indexOf(OSC11_RESPONSE_PREFIX_NO_ESC);
  if (noEscPrefixIndex !== -1) return noEscPrefixIndex;

  for (let i = 0; i < data.length; i++) {
    const suffix = data.slice(i);
    if (OSC11_RESPONSE_PREFIX.startsWith(suffix) && suffix.length > 1) return i;
    if (OSC11_RESPONSE_PREFIX_NO_ESC.startsWith(suffix) && suffix.startsWith(']11;')) {
      return i;
    }
  }

  return -1;
}

function resultFromRemaining(data: string): TerminalThemeInputResult {
  if (data.length === 0) return { consume: true };
  return { data };
}

/** The slice of the shell the theme tracker needs. */
export interface TerminalThemeHost {
  /** Register a raw input listener; returns an unsubscribe function. */
  onRawInput(listener: (data: string) => void): () => void;
  /** Write bytes to the terminal. */
  write(data: string): void;
}

export function installTerminalThemeTracking(
  host: TerminalThemeHost,
  onTheme: (theme: ResolvedTheme) => void,
): () => void {
  const inputState = createTerminalThemeInputState();
  const disposeInputListener = host.onRawInput((data) =>
    handleTerminalThemeInput(data, (bytes) => host.write(bytes), onTheme, inputState),
  );
  host.write(ENABLE_TERMINAL_THEME_REPORTING);
  host.write(OSC11_QUERY);
  host.write(QUERY_TERMINAL_THEME);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    disposeInputListener();
    host.write(DISABLE_TERMINAL_THEME_REPORTING);
  };
}
