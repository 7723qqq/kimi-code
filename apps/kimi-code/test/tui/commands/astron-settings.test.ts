import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { saveAstronSettings, showAstronSettingsPanel } from '#/tui/commands/config';
import { darkColors } from '#/tui/theme/colors';

vi.mock('#/i18n', () => ({
  t: (key: string) => {
    const translations: Record<string, string> = {
      'tui.dialogs.astronSettings.title': 'Astron provider settings',
      'tui.dialogs.astronSettings.hint': 'Ctrl-S saves',
      'tui.dialogs.astronSettings.saved': 'Astron settings saved.',
      'tui.dialogs.astronSettings.notConfigured': 'No [providers.astron] section in config.toml.',
      'tui.dialogs.astronSettings.temperatureOutOfRange': 'Temperature must be between 0 and 2.',
      'tui.dialogs.astronSettings.maxTokensOutOfRange': 'Max tokens must be at least 1.',
      'tui.dialogs.astronSettings.on': 'on',
      'tui.dialogs.astronSettings.off': 'off',
    };
    return translations[key] ?? key;
  },
  setLocale: vi.fn(),
  getLocale: () => 'en',
}));

type Panel = Component & Focusable & { handleInput(data: string): void };

const ANSI = /\u001b\[[0-9;]*m/g;

const MODELS = {
  kimi: { provider: 'moonshot', model: 'kimi-k2', maxContextSize: 200000 },
};
const PROVIDERS = {
  moonshot: { type: 'kimi', apiKey: 'sk-test' },
  astron: {
    type: 'astron',
    baseUrl: 'https://astron.example.test/v2',
    stream: true,
    temperature: 1,
    maxTokens: 32768,
    searchDisable: true,
  },
};
const THINKING = { enabled: true, effort: 'medium' };

function makeHost(config: Record<string, unknown> = {}) {
  const mounted: Panel[] = [];
  const host = {
    state: {
      theme: { palette: darkColors },
      appState: {},
    },
    harness: {
      getConfig: vi.fn(async () => config),
      setConfig: vi.fn(async () => ({ providers: {} })),
    },
    mountEditorReplacement: vi.fn((panel: Panel) => {
      mounted.push(panel);
    }),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: {
      getConfig: ReturnType<typeof vi.fn>;
      setConfig: ReturnType<typeof vi.fn>;
    };
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  return { host, mounted };
}

function plain(panel: Panel, width = 80): string {
  return panel
    .render(width)
    .map((line) => line.replaceAll(ANSI, ''))
    .join('\n');
}

describe('saveAstronSettings', () => {
  it('reloads config.toml before patching so a stale snapshot cannot resurrect deleted keys', async () => {
    // A watcher-less environment hands back the in-memory view without
    // `reload`; the patch then carries whatever that view still holds.
    const { host } = makeHost({
      providers: PROVIDERS,
      models: MODELS,
      defaultModel: 'kimi',
      thinking: THINKING,
    });

    await saveAstronSettings(host, {
      stream: false,
      temperature: 0.5,
      maxTokens: 4096,
      searchDisable: false,
    });

    expect(host.harness.getConfig).toHaveBeenCalledWith({ reload: true });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      providers: {
        ...PROVIDERS,
        astron: {
          ...PROVIDERS.astron,
          stream: false,
          temperature: 0.5,
          maxTokens: 4096,
          searchDisable: false,
        },
      },
      models: MODELS,
      defaultModel: 'kimi',
      thinking: THINKING,
    });
    expect(host.showStatus).toHaveBeenCalledWith('Astron settings saved.');
  });

  it('writes the reloaded document it was handed, not a cached one', async () => {
    const getConfig = vi.fn(async () => ({
      providers: { astron: PROVIDERS.astron },
      models: {},
    }));
    const setConfig = vi.fn(async () => ({ providers: {} }));
    const { host } = makeHost();
    host.harness.getConfig = getConfig as never;
    host.harness.setConfig = setConfig as never;

    await saveAstronSettings(host, {
      stream: true,
      temperature: 1.25,
      maxTokens: 2048,
      searchDisable: true,
    });

    // Evidence that the reloaded view (empty [models]) is what the patch carries:
    // a stale snapshot with models would have written `models: MODELS` instead.
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ models: {} }));
  });

  it('does not write anything when the reloaded config has no [providers.astron]', async () => {
    const { host } = makeHost({ providers: { moonshot: PROVIDERS.moonshot }, models: MODELS });

    await saveAstronSettings(host, {
      stream: true,
      temperature: 1,
      maxTokens: 32768,
      searchDisable: true,
    });

    expect(host.harness.getConfig).toHaveBeenCalledWith({ reload: true });
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'No [providers.astron] section in config.toml.',
    );
  });

  it('rejects out-of-range values before touching the config', async () => {
    const { host } = makeHost({ providers: PROVIDERS, models: MODELS });

    await saveAstronSettings(host, {
      stream: true,
      temperature: 3,
      maxTokens: 32768,
      searchDisable: true,
    });

    expect(host.harness.getConfig).not.toHaveBeenCalled();
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Temperature must be between 0 and 2.');
  });
});

describe('showAstronSettingsPanel', () => {
  it('prefills the panel from a freshly reloaded config', async () => {
    const { host, mounted } = makeHost({
      providers: {
        ...PROVIDERS,
        astron: { ...PROVIDERS.astron, temperature: 0.7, maxTokens: 512 },
      },
    });

    await showAstronSettingsPanel(host);

    expect(host.harness.getConfig).toHaveBeenCalledWith({ reload: true });
    const panel = mounted.at(-1);
    expect(panel).toBeDefined();
    const rendered = plain(panel as Panel);
    expect(rendered).toContain('0.7');
    expect(rendered).toContain('512');
  });
});
