import { describe, expect, it, mock, type Mock } from 'bun:test';

import type { Component, Focusable } from '@moonshot-ai/pi-tui';

import type { SlashCommandHost } from '#/tui/commands';
import {
  savePromptOptimizerSettings,
  showPromptOptimizerSettingsPanel,
} from '#/tui/commands/config';
import {
  PromptOptimizerSettingsComponent,
  type PromptOptimizerSettings,
} from '#/tui/components/dialogs/prompt-optimizer-settings';
import { darkColors } from '#/tui/theme/colors';

void mock.module('#/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      'tui.dialogs.promptOptimizerSettings.title': 'Prompt optimizer',
      'tui.dialogs.promptOptimizerSettings.hint':
        '↑↓ effort · type seconds · Enter save · Esc cancel',
      'tui.dialogs.promptOptimizerSettings.followMain': 'Follow the main agent',
      'tui.dialogs.promptOptimizerSettings.timeoutLabel': 'Time budget (seconds):',
      'tui.dialogs.promptOptimizerSettings.timeoutDefault': 'default 180',
      'tui.dialogs.promptOptimizerSettings.timeoutOutOfRange':
        'Seconds must be between {{min}} and {{max}}.',
      'tui.dialogs.promptOptimizerSettings.saved': 'Prompt optimizer settings saved.',
    };
    let text = translations[key] ?? key;
    for (const [name, value] of Object.entries(params ?? {})) {
      text = text.replaceAll(`{{${name}}}`, String(value));
    }
    return text;
  },
  setLocale: mock(),
  getLocale: () => 'en',
}));

type Panel = Component & Focusable & { handleInput(data: string): void };

const ANSI = /\u001B\[[0-9;]*m/g;

function makeHost(config: Record<string, unknown> = {}) {
  const mounted: Panel[] = [];
  const host = {
    state: {
      theme: { palette: darkColors },
      appState: { availableModels: {} },
    },
    harness: {
      getConfig: mock(() => Promise.resolve(config)),
      setConfig: mock(() => Promise.resolve({})),
    },
    mountEditorReplacement: mock((panel: Panel) => {
      mounted.push(panel);
    }),
    restoreEditor: mock(),
    showStatus: mock(),
    showError: mock(),
  } as unknown as SlashCommandHost & {
    harness: {
      getConfig: Mock<(...args: any[]) => any>;
      setConfig: Mock<(...args: any[]) => any>;
    };
    mountEditorReplacement: Mock<(...args: any[]) => any>;
    restoreEditor: Mock<(...args: any[]) => any>;
    showStatus: Mock<(...args: any[]) => any>;
    showError: Mock<(...args: any[]) => any>;
  };
  return { host, mounted };
}

function plain(panel: Panel, width = 80): string {
  return panel
    .render(width)
    .map((line) => line.replaceAll(ANSI, ''))
    .join('\n');
}

describe('showPromptOptimizerSettingsPanel', () => {
  it('opens the settings panel prefilled from the freshly reloaded config', async () => {
    const { host, mounted } = makeHost({
      promptOptimizer: { timeoutMs: 120000, effort: 'high' },
    });

    await showPromptOptimizerSettingsPanel(host);

    expect(host.harness.getConfig).toHaveBeenCalledWith({ reload: true });
    const panel = mounted.at(-1);
    expect(panel).toBeInstanceOf(PromptOptimizerSettingsComponent);
    const rendered = plain(panel as Panel);
    expect(rendered).toContain('Prompt optimizer');
    expect(rendered).toContain('❯ high');
    expect(rendered).toContain('120s');
  });

  it('falls back to the follow-main row and the default placeholder on an empty section', async () => {
    const { host, mounted } = makeHost();

    await showPromptOptimizerSettingsPanel(host);

    const rendered = plain(mounted.at(-1) as Panel);
    expect(rendered).toContain('❯ Follow the main agent');
    expect(rendered).toContain('default 180');
  });
});

describe('savePromptOptimizerSettings', () => {
  it('writes the [prompt_optimizer] section and restores the editor with a saved status', async () => {
    const { host } = makeHost();

    await savePromptOptimizerSettings(host, { timeoutMs: 90000, effort: 'high' });

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      promptOptimizer: { timeoutMs: 90000, effort: 'high' },
    });
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Prompt optimizer settings saved.', 'success');
  });

  it('clears the section fields when both values follow the defaults', async () => {
    const { host } = makeHost();

    await savePromptOptimizerSettings(host, { timeoutMs: undefined, effort: undefined });

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      promptOptimizer: { timeoutMs: undefined, effort: undefined },
    });
    expect(host.showStatus).toHaveBeenCalledWith('Prompt optimizer settings saved.', 'success');
  });
});

describe('PromptOptimizerSettingsComponent', () => {
  const EFFORTS = ['off', 'low', 'medium', 'high'] as const;

  function makePanel(initial?: PromptOptimizerSettings) {
    const saved: PromptOptimizerSettings[] = [];
    const panel = new PromptOptimizerSettingsComponent({
      initial: initial ?? { timeoutMs: undefined, effort: undefined },
      efforts: EFFORTS,
      onSave: (settings) => saved.push(settings),
      onCancel: mock(),
    });
    return { panel, saved, onCancel: panel['opts'].onCancel as Mock<() => void> };
  }

  it('escape cancels without saving', () => {
    const { panel, saved, onCancel } = makePanel();

    panel.handleInput('\u001B');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([]);
  });

  it('saves the typed seconds and the selected effort', () => {
    const { panel, saved } = makePanel({ timeoutMs: undefined, effort: 'medium' });

    panel.handleInput('\u001B[B');
    panel.handleInput('9');
    panel.handleInput('0');
    panel.handleInput('\r');

    expect(saved).toEqual([{ timeoutMs: 90000, effort: 'high' }]);
  });

  it('hands back an unset effort when the follow-main row is saved, never the sentinel', () => {
    const { panel, saved } = makePanel();

    panel.handleInput('\r');

    expect(saved).toEqual([{ timeoutMs: undefined, effort: undefined }]);
  });

  it('falls back to follow-main when the stored effort is not one this model offers', () => {
    const { panel, saved } = makePanel({ timeoutMs: 120000, effort: 'max' });

    expect(plain(panel)).toContain('❯ Follow the main agent');

    panel.handleInput('\r');
    expect(saved).toEqual([{ timeoutMs: 120000, effort: undefined }]);
  });

  it('rejects a time budget outside 10-3600 seconds without saving', () => {
    const { panel, saved } = makePanel();

    panel.handleInput('5');
    panel.handleInput('\r');

    expect(saved).toEqual([]);
    expect(plain(panel)).toContain('Seconds must be between 10 and 3600.');
  });
});
