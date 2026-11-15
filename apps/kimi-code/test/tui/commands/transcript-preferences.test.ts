import { describe, expect, it, mock } from 'bun:test';

import { t } from '#/i18n';
import { applyTranscriptConfigChoice } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { SettingsSelectorComponent } from '#/tui/components/dialogs/settings-selector';
import type { TranscriptConfig } from '#/tui/config';

const saveTuiConfig = mock();
const actualConfig = await import('#/tui/config');
void mock.module('#/tui/config', () => ({
  ...actualConfig,
  saveTuiConfig,
}));

function makeHost(transcript: TranscriptConfig, mode: 'fullscreen' | 'regular' = 'fullscreen') {
  const host = {
    state: {
      appState: {
        theme: 'auto',
        tuiMode: mode,
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' },
        upgrade: { autoInstall: true },
        transcript,
      },
      transcriptContainer: { setPresentationOptions: mock() },
      ui: { mode },
    },
    setAppState: mock((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showStatus: mock(),
    track: mock(),
  } as unknown as SlashCommandHost & {
    setAppState: ReturnType<typeof mock>;
    showStatus: ReturnType<typeof mock>;
    track: ReturnType<typeof mock>;
  };
  return host;
}

function settingsValues(fullscreen: boolean): string[] {
  const picker = new SettingsSelectorComponent({
    fullscreen,
    onSelect: () => {},
    onCancel: () => {},
  }) as unknown as { opts: { options: readonly { value: string }[] } };
  return picker.opts.options.map((option) => option.value);
}

describe('transcript preference commands', () => {
  it('saves group values, updates appState, and records settings telemetry', async () => {
    saveTuiConfig.mockClear();
    const host = makeHost({ groupTools: 'auto', groupThinking: true });
    const transcript: TranscriptConfig = { groupTools: 'explore', groupThinking: false };

    await applyTranscriptConfigChoice(host, transcript);

    expect(saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ transcript, tuiMode: 'fullscreen' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ transcript });
    expect(host.state.transcriptContainer.setPresentationOptions).toHaveBeenCalledWith({
      fullscreen: true,
      groupTools: 'explore',
      groupThinking: false,
    });
    expect(host.track).toHaveBeenCalledWith('transcript_display_settings', {
      group_tools: 'explore',
      group_thinking: false,
      source: 'settings',
    });
    expect(host.showStatus).toHaveBeenCalledWith(t('tui.messages.configTranscriptUpdated'), 'success');
  });

  it('does not rewrite or track unchanged values', async () => {
    saveTuiConfig.mockClear();
    const host = makeHost({ groupTools: 'off', groupThinking: false });

    await applyTranscriptConfigChoice(host, { groupTools: 'off', groupThinking: false });

    expect(saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(t('tui.messages.configTranscriptUnchanged'));
  });

  it('reports a save failure without touching appState or telemetry', async () => {
    saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost({ groupTools: 'auto', groupThinking: true });

    await applyTranscriptConfigChoice(host, { groupTools: 'explore', groupThinking: true });

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      t('tui.messages.configTranscriptSaveFailed', { error: 'disk full' }),
      'error',
    );
  });
});

describe('transcript settings entries', () => {
  it('offers the grouping entries only in fullscreen', () => {
    expect(settingsValues(true)).toContain('groupTools');
    expect(settingsValues(true)).toContain('groupThinking');
    expect(settingsValues(false)).not.toContain('groupTools');
    expect(settingsValues(false)).not.toContain('groupThinking');
  });
});
