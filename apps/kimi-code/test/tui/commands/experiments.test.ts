import type { ExperimentalFeatureState } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, describe, expect, it, mock, type Mock } from 'bun:test';

import type { SlashCommandHost } from '#/tui/commands';
import { applyExperimentalFeatureChanges } from '#/tui/commands/config';
import {
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
} from '#/tui/commands/experimental-flags';
import { darkColors } from '#/tui/theme/colors';

void mock.module('#/i18n', () => ({
  t: (key: string) => {
    const translations: Record<string, string> = {
      'tui.messages.configNoExperimentalChanges': 'No experimental feature changes to apply.',
      'tui.statusMessages.experimentalUpdatedSessionReloaded':
        'Experimental features updated. Session reloaded.',
      'tui.statusMessages.experimentalUpdated': 'Experimental features updated.',
      'tui.messages.experimentalTowerRestart':
        'Tower mode takes effect after restarting Kimi Code.',
      'tui.messages.experimentalNotifyUserNewSession':
        'Start a new session to use Updates if this session was created with the feature disabled.',
    };
    return translations[key] ?? key;
  },
  setLocale: mock(),
  getLocale: () => 'en',
}));

function feature(overrides: Partial<ExperimentalFeatureState> = {}): ExperimentalFeatureState {
  return {
    id: 'micro_compaction',
    title: 'Micro compaction',
    description: 'Trim older tool results.',
    surface: 'core',
    env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    defaultEnabled: true,
    enabled: true,
    source: 'default',
    ...overrides,
  };
}

function makeHost() {
  const session = {
    id: 'ses-experiments',
    reloadSession: mock(async () => ({})),
  };
  const host = {
    state: {
      theme: { palette: darkColors },
      ui: { requestRender: mock() },
    },
    harness: {
      setConfig: mock(async () => ({ providers: {} })),
      getExperimentalFeatures: mock(async () => [
        feature({ enabled: false, source: 'config', configValue: false }),
      ]),
      reloadSession: mock(async () => session),
    },
    session,
    refreshSlashCommandAutocomplete: mock(),
    reloadCurrentSessionView: mock(async () => {}),
    mountEditorReplacement: mock(),
    restoreEditor: mock(),
    showStatus: mock(),
    showError: mock(),
    showNotice: mock(),
    track: mock(),
  } as unknown as SlashCommandHost & {
    harness: {
      setConfig: Mock<(...args: any[]) => any>;
      getExperimentalFeatures: Mock<(...args: any[]) => any>;
      reloadSession: Mock<(...args: any[]) => any>;
    };
    refreshSlashCommandAutocomplete: Mock<(...args: any[]) => any>;
    reloadCurrentSessionView: Mock<(...args: any[]) => any>;
    mountEditorReplacement: Mock<(...args: any[]) => any>;
    restoreEditor: Mock<(...args: any[]) => any>;
    showStatus: Mock<(...args: any[]) => any>;
    showError: Mock<(...args: any[]) => any>;
    track: Mock<(...args: any[]) => any>;
    session: typeof session;
  };
  return host;
}

describe('experimental feature command handlers', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('persists config overrides, refreshes command flags, closes the panel, and reloads', async () => {
    const host = makeHost();

    await applyExperimentalFeatureChanges(host, [{ id: 'micro_compaction', enabled: false }]);

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      experimental: { micro_compaction: false },
    });
    expect(host.harness.getExperimentalFeatures).toHaveBeenCalledTimes(1);
    expect(isExperimentalFlagEnabled('micro_compaction')).toBe(false);
    expect(host.refreshSlashCommandAutocomplete).toHaveBeenCalled();
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.harness.reloadSession).toHaveBeenCalledWith({ id: host.session.id });
    expect(host.session.reloadSession).not.toHaveBeenCalled();
    expect(host.reloadCurrentSessionView).toHaveBeenCalledWith(
      host.session,
      'Experimental features updated. Session reloaded.',
    );
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.track).toHaveBeenCalledWith('experimental_features_apply', {
      changed: 1,
      flags: '',
    });
    expect(host.showStatus).not.toHaveBeenCalledWith(
      'Experimental features updated.',
      darkColors.success,
    );
  });

  it.each([true, false])(
    'toggles notification display without reloading the session: %s',
    async (enabled) => {
      const host = makeHost();
      host.harness.getExperimentalFeatures.mockResolvedValue([
        feature({ id: 'notify_user', enabled }),
      ]);
      await applyExperimentalFeatureChanges(host, [{ id: 'notify_user', enabled }]);
      expect(host.harness.setConfig).toHaveBeenCalledWith({
        experimental: { notify_user: enabled },
      });
      expect(isExperimentalFlagEnabled('notify_user')).toBe(enabled);
      expect(host.refreshSlashCommandAutocomplete).toHaveBeenCalledTimes(1);
      expect(host.harness.reloadSession).not.toHaveBeenCalled();
      expect(host.reloadCurrentSessionView).not.toHaveBeenCalled();
      expect(host.showError).not.toHaveBeenCalled();
    },
  );

  it('still reloads when another experimental feature changes alongside notifications', async () => {
    const host = makeHost();
    await applyExperimentalFeatureChanges(host, [
      { id: 'notify_user', enabled: false },
      { id: 'micro_compaction', enabled: false },
    ]);
    expect(host.harness.reloadSession).toHaveBeenCalledTimes(1);
  });

  it('reports the post-apply enabled flag set in telemetry', async () => {
    const host = makeHost();
    host.harness.getExperimentalFeatures.mockResolvedValue([
      feature({ id: 'wait_for', enabled: true }),
      feature({ id: 'subagent_fork', enabled: true }),
      feature({ id: 'tower', enabled: false }),
    ]);

    await applyExperimentalFeatureChanges(host, [{ id: 'subagent_fork', enabled: true }]);

    expect(host.track).toHaveBeenCalledWith('experimental_features_apply', {
      changed: 1,
      flags: 'subagent_fork,wait_for',
    });
  });

  it('does not write config when there are no drafted changes', async () => {
    const host = makeHost();

    await applyExperimentalFeatureChanges(host, []);

    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'No experimental feature changes to apply.',
      'textMuted',
    );
  });

  it('notices that tower mode needs a restart when the tower flag changes', async () => {
    const host = makeHost();

    await applyExperimentalFeatureChanges(host, [{ id: 'tower', enabled: true }]);

    expect(host.showNotice).toHaveBeenCalledWith(
      'Tower mode takes effect after restarting Kimi Code.',
    );
  });

  it('does not show the restart notice for non-tower changes', async () => {
    const host = makeHost();

    await applyExperimentalFeatureChanges(host, [{ id: 'micro_compaction', enabled: false }]);

    expect(host.showNotice).not.toHaveBeenCalled();
  });
});
