import { describe, expect, it, mock, spyOn } from 'bun:test';

import { applyUpdatePreferenceChoice } from '#/tui/commands/config';
import * as tuiConfig from '#/tui/config';
import { darkColors } from '#/tui/theme/colors';

const mocks = {
  saveTuiConfig: spyOn(tuiConfig, 'saveTuiConfig').mockImplementation(async () => {}),
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
};

void mock.module('#/i18n', () => ({
  t: mocks.t,
  setLocale: mock(),
  getLocale: () => 'en',
}));

describe('update preference commands', () => {
  it('saves automatic update preference changes to tui.toml', async () => {
    const setAppState = mock();
    const showStatus = mock();
    const track = mock();
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
      disableFeedbackSurvey: false,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: false },
      statusLine: { items: null, command: null },
      markdown: { mermaid: 'final' },
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
      setAppState: mock(),
      showStatus: mock(),
      track: mock(),
    };

    await applyUpdatePreferenceChoice(host, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ renderLatex: false }),
    );
  });
});
