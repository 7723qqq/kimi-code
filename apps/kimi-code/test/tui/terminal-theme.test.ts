import { describe, expect, it, mock } from 'bun:test';

import type { TUIState } from '#/tui/kimi-tui';
import { getBuiltInPalette } from '#/tui/theme';
import { colorDistance, mixColors } from '#/tui/theme/color-mix';
import { darkColors, lightColors } from '#/tui/theme/colors';
import { Theme } from '#/tui/theme/theme';
import {
  DISABLE_TERMINAL_THEME_REPORTING,
  ENABLE_TERMINAL_THEME_REPORTING,
  OSC11_QUERY,
  QUERY_TERMINAL_THEME,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
  createTerminalThemeInputState,
  hasTerminalThemeReport,
  handleTerminalThemeInput,
  installTerminalThemeTracking,
} from '#/tui/utils/terminal-theme';

type InputListener = Parameters<TUIState['ui']['addInputListener']>[0];
const DARK_OSC11_REPORT = '\u001B]11;rgb:2828/2c2c/3434\u0007';
const LIGHT_OSC11_REPORT = '\u001B]11;rgb:fafa/fbfb/fcfc\u0007';

describe('terminal theme tracking', () => {
  it('recognizes terminal theme reports as change notifications', () => {
    expect(hasTerminalThemeReport(TERMINAL_THEME_DARK)).toBe(true);
    expect(hasTerminalThemeReport(TERMINAL_THEME_LIGHT)).toBe(true);
    expect(hasTerminalThemeReport(`x${TERMINAL_THEME_LIGHT}y`)).toBe(true);
    expect(hasTerminalThemeReport('x')).toBe(false);
  });

  it('consumes theme reports by querying the terminal background', () => {
    const terminal = { write: mock() };
    const onTheme = mock();

    expect(handleTerminalThemeInput(TERMINAL_THEME_DARK, terminal, onTheme)).toEqual({
      consume: true,
    });
    expect(handleTerminalThemeInput(TERMINAL_THEME_LIGHT, terminal, onTheme)).toEqual({
      consume: true,
    });

    expect(terminal.write).toHaveBeenCalledTimes(2);
    expect(terminal.write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(onTheme).not.toHaveBeenCalled();
  });

  it('strips terminal theme reports without dropping coalesced input', () => {
    const terminal = { write: mock() };
    const onTheme = mock();

    expect(handleTerminalThemeInput(`a${TERMINAL_THEME_LIGHT}b`, terminal, onTheme)).toEqual({
      data: 'ab',
    });

    expect(terminal.write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(onTheme).not.toHaveBeenCalled();
  });

  it('consumes OSC 11 background reports and forwards resolved themes', () => {
    const terminal = { write: mock() };
    const onTheme = mock();

    expect(handleTerminalThemeInput(DARK_OSC11_REPORT, terminal, onTheme)).toEqual({
      consume: true,
    });
    expect(onTheme).toHaveBeenLastCalledWith('dark');

    expect(handleTerminalThemeInput(LIGHT_OSC11_REPORT, terminal, onTheme)).toEqual({
      consume: true,
    });
    expect(onTheme).toHaveBeenLastCalledWith('light');

    expect(handleTerminalThemeInput('x', terminal, onTheme)).toBeUndefined();
    expect(handleTerminalThemeInput(']', terminal, onTheme)).toBeUndefined();
    expect(onTheme).toHaveBeenCalledTimes(2);
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it('strips OSC 11 background reports without dropping coalesced input', () => {
    const terminal = { write: mock() };
    const onTheme = mock();

    expect(handleTerminalThemeInput(`a${DARK_OSC11_REPORT}b`, terminal, onTheme)).toEqual({
      data: 'ab',
    });

    expect(onTheme).toHaveBeenCalledWith('dark');
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it('accumulates fragmented OSC 11 background reports', () => {
    const terminal = { write: mock() };
    const onTheme = mock();
    const inputState = createTerminalThemeInputState();

    expect(
      handleTerminalThemeInput('\u001B]11;rgb:2828/2c2c/3', terminal, onTheme, inputState),
    ).toEqual({ consume: true });
    expect(onTheme).not.toHaveBeenCalled();

    expect(handleTerminalThemeInput('434\u0007', terminal, onTheme, inputState)).toEqual({
      consume: true,
    });
    expect(onTheme).toHaveBeenCalledWith('dark');
    expect(inputState.osc11Buffer).toBe('');
  });

  it('forwards input that follows a fragmented OSC 11 background report', () => {
    const terminal = { write: mock() };
    const onTheme = mock();
    const inputState = createTerminalThemeInputState();

    expect(
      handleTerminalThemeInput('\u001B]11;rgb:2828/2c2c/3', terminal, onTheme, inputState),
    ).toEqual({ consume: true });

    expect(handleTerminalThemeInput('434\u0007x', terminal, onTheme, inputState)).toEqual({
      data: 'x',
    });
    expect(onTheme).toHaveBeenCalledWith('dark');
    expect(inputState.osc11Buffer).toBe('');
  });

  it('enables reporting, queries current theme, and disables on dispose', () => {
    const listeners: InputListener[] = [];
    const removeInputListener = mock();
    const onTheme = mock();
    const state = {
      terminal: {
        write: mock(),
      },
      ui: {
        addInputListener: mock((listener: InputListener) => {
          listeners.push(listener);
          return removeInputListener;
        }),
      },
    } as unknown as Pick<TUIState, 'terminal' | 'ui'>;

    const dispose = installTerminalThemeTracking(state, onTheme);

    expect(state.terminal.write).toHaveBeenCalledWith(ENABLE_TERMINAL_THEME_REPORTING);
    expect(state.terminal.write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(state.terminal.write).toHaveBeenCalledWith(QUERY_TERMINAL_THEME);
    expect(listeners).toHaveLength(1);

    expect(listeners[0]?.(TERMINAL_THEME_LIGHT)).toEqual({ consume: true });
    expect(state.terminal.write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(onTheme).not.toHaveBeenCalled();

    expect(listeners[0]?.('\u001B]11;rgb:2828/2c2c/3')).toEqual({ consume: true });
    expect(onTheme).not.toHaveBeenCalled();

    expect(listeners[0]?.('434\u0007')).toEqual({ consume: true });
    expect(onTheme).toHaveBeenCalledWith('dark');

    dispose();

    expect(removeInputListener).toHaveBeenCalledTimes(1);
    expect(state.terminal.write).toHaveBeenCalledWith(DISABLE_TERMINAL_THEME_REPORTING);
  });
});

describe('transcript group colors', () => {
  it('mixes existing colors and measures their distance', () => {
    expect(mixColors('#000000', '#FFFFFF', 0.45)).toBe('#737373');
    expect(mixColors('#454545', '#FFFFFF', 0.35)).toBe('#868686');
    expect(mixColors('#454545', '#FFFFFF', 0.65)).toBe('#bebebe');
    expect(colorDistance('#888888', '#1E1E1E')).toBeCloseTo(183.60, 2);
  });

  it('uses the detected background and falls back from the palette family', () => {
    const light = new Theme(lightColors, 'light');
    expect(light.terminalBackground()).toBe('#FFFFFF');
    light.setTerminalBackground('#FAFBFC');
    expect(light.terminalBackground()).toBe('#FAFBFC');

    const dark = new Theme(darkColors, 'dark');
    expect(dark.terminalBackground()).toBe('#000000');
    dark.setTerminalBackground('#1E1E1E');
    expect(dark.terminalBackground()).toBe('#1E1E1E');
  });
});

describe('ColorPalette warning token', () => {
  it('has a defined warning color in both themes', () => {
    expect(darkColors.warning).toBeTruthy();
    expect(lightColors.warning).toBeTruthy();
    expect(darkColors.warning).not.toBe(lightColors.warning);
  });

  it('resolves the correct palette by theme name', () => {
    expect(getBuiltInPalette('dark')).toBe(darkColors);
    expect(getBuiltInPalette('light')).toBe(lightColors);
  });
});
