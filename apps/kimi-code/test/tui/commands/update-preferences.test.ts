import { describe, expect, it, vi } from 'vitest';

import { applyUpdatePreferenceChoice } from '#/tui/commands/config';
import { darkColors } from '#/tui/theme/colors';

const mocks = vi.hoisted(() => ({
  saveTuiConfig: vi.fn(),
  t: (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      'tui.messages.configAutoUpdateSet': `Automatic updates ${String(params?.['state'] ?? '')}.`,
      'tui.messages.configAutoUpdateAlready': `Automatic updates already ${String(params?.['state'] ?? '')}.`,
      'tui.messages.configAutoUpdateSaveFailed':
        'Failed to save automatic update setting: {{error}}',
      'tui.messages.configAutoUpdateEnabled': 'enabled',
      'tui.messages.configAutoUpdateDisabled': 'disabled',
      'tui.messages.configPermissionUnchanged': 'Permission mode unchanged: {{mode}}.',
      'tui.messages.configPermissionMode': 'Permission mode: {{mode}}',
    };
    return translations[key] ?? key;
  },
}));

vi.mock('#/i18n', () => ({
  t: mocks.t,
  setLocale: vi.fn(),
  getLocale: () => 'en',
}));

vi.mock('../../../src/tui/config', async () => {
  const actual = await vi.importActual<typeof import('../../../src/tui/config.js')>(
    '../../../src/tui/config.js',
  );
  return {
    ...actual,
    saveTuiConfig: mocks.saveTuiConfig,
  };
});

describe('update preference commands', () => {
  it('saves automatic update preference changes to tui.toml', async () => {
    const setAppState = vi.fn();
    const showStatus = vi.fn();
    const track = vi.fn();
    const host = {
      state: {
        appState: {
          theme: 'auto' as const,
          locale: 'en',
          editorCommand: null,
          notifications: { enabled: true, condition: 'unfocused' as const },
          upgrade: { autoInstall: true },
        },
        theme: { palette: darkColors },
      },
      setAppState,
      showStatus,
      track,
    };

    await applyUpdatePreferenceChoice(host, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith({
      theme: 'auto',
      locale: 'en',
      editorCommand: null,
      disablePasteBurst: false,
      renderLatex: true,
      cacheExpiryHint: true,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: false },
      statusLine: { items: null, command: null },
      astron: { stream: true, temperature: 1, maxTokens: 32768, searchDisable: true },
    });
    expect(setAppState).toHaveBeenCalledWith({ upgrade: { autoInstall: false } });
    expect(track).toHaveBeenCalledWith('upgrade_preference_changed', { auto_install: false });
    expect(showStatus).toHaveBeenCalledWith('Automatic updates disabled.');
  });

  it('preserves a render_latex opt-out when saving an unrelated preference', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = {
      state: {
        appState: {
          theme: 'auto' as const,
          editorCommand: null,
          renderLatex: false,
          notifications: { enabled: true, condition: 'unfocused' as const },
          upgrade: { autoInstall: true },
        },
        theme: { palette: darkColors },
      },
      setAppState: vi.fn(),
      showStatus: vi.fn(),
      track: vi.fn(),
    };

    await applyUpdatePreferenceChoice(host, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ renderLatex: false }),
    );
  });
});
