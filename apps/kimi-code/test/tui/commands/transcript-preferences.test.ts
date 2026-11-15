import { describe, expect, it, mock } from 'bun:test';

import { TuiAltScreen } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { applyCopyOnSelectChoice, applyTranscriptConfigChoice } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { SettingsSelectorComponent } from '#/tui/components/dialogs/settings-selector';
import type { TranscriptConfig } from '#/tui/config';

import { VirtualTerminal } from '../../../../../packages/pi-tui/test/virtual-terminal';

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
  it('saves both display values, updates appState, and records settings telemetry', async () => {
    saveTuiConfig.mockClear();
    const host = makeHost({ toolCallDensity: 'compact', thinking: 'grouped' });
    const transcript: TranscriptConfig = { toolCallDensity: 'detailed', thinking: 'ungrouped' };

    await applyTranscriptConfigChoice(host, transcript);

    expect(saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ transcript, tuiMode: 'fullscreen' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ transcript });
    expect(host.state.transcriptContainer.setPresentationOptions).toHaveBeenCalledWith({
      fullscreen: true,
      toolCallDensity: 'detailed',
      thinking: 'ungrouped',
    });
    expect(host.track).toHaveBeenCalledWith('transcript_display_settings', {
      tool_call_density: 'detailed',
      thinking: 'ungrouped',
      source: 'settings',
    });
    expect(host.showStatus).toHaveBeenCalledWith(t('tui.messages.configTranscriptUpdated'), 'success');
  });

  it('does not rewrite or track unchanged values', async () => {
    saveTuiConfig.mockClear();
    const host = makeHost({ toolCallDensity: 'ungrouped', thinking: 'ungrouped' });

    await applyTranscriptConfigChoice(host, { toolCallDensity: 'ungrouped', thinking: 'ungrouped' });

    expect(saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(t('tui.messages.configTranscriptUnchanged'));
  });

  it('reports a save failure without touching appState or telemetry', async () => {
    saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost({ toolCallDensity: 'compact', thinking: 'grouped' });

    await applyTranscriptConfigChoice(host, { toolCallDensity: 'detailed', thinking: 'grouped' });

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
    expect(settingsValues(true)).toContain('toolCallDensity');
    expect(settingsValues(true)).toContain('thinking');
    expect(settingsValues(true)).toContain('copyOnSelect');
    expect(settingsValues(false)).not.toContain('toolCallDensity');
    expect(settingsValues(false)).not.toContain('thinking');
    expect(settingsValues(false)).not.toContain('copyOnSelect');
  });
});

describe('copy on select preference', () => {
  function makeCopyOnSelectHost(copyOnSelect: boolean | undefined) {
    const ui = new TuiAltScreen(new VirtualTerminal(40, 10), undefined, undefined, {
      copyOnSelect,
    });
    const host = makeHost({ toolCallDensity: 'compact', thinking: 'grouped' });
    Object.assign(host.state, { ui });
    Object.assign(host.state.appState, { copyOnSelect });
    return { host, ui };
  }

  it('saves the choice to tui.toml, mirrors appState, and applies it to the live fullscreen renderer', async () => {
    saveTuiConfig.mockClear();
    const { host, ui } = makeCopyOnSelectHost(undefined);

    await applyCopyOnSelectChoice(host, false);

    expect(saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        copyOnSelect: false,
        transcript: host.state.appState.transcript,
      }),
    );
    expect(host.state.appState.copyOnSelect).toBe(false);
    expect(ui.getCopyOnSelect()).toBe(false);
    expect(host.showStatus).toHaveBeenCalledWith(t('tui.messages.configCopyOnSelectDisabled'));
  });

  it('reports an unchanged choice without saving', async () => {
    saveTuiConfig.mockClear();
    const { host, ui } = makeCopyOnSelectHost(true);

    await applyCopyOnSelectChoice(host, true);

    expect(saveTuiConfig).not.toHaveBeenCalled();
    expect(ui.getCopyOnSelect()).toBe(true);
    expect(host.showStatus).toHaveBeenCalledWith(
      t('tui.messages.configCopyOnSelectAlreadyEnabled'),
    );
  });

  it('keeps the live setting when tui.toml cannot be saved', async () => {
    saveTuiConfig.mockClear();
    saveTuiConfig.mockRejectedValueOnce(new Error('read-only file system'));
    const { host, ui } = makeCopyOnSelectHost(true);

    await applyCopyOnSelectChoice(host, false);

    expect(host.state.appState.copyOnSelect).toBe(true);
    expect(ui.getCopyOnSelect()).toBe(true);
    expect(host.showStatus).toHaveBeenCalledWith(
      t('tui.messages.configCopyOnSelectSaveFailed', { error: 'read-only file system' }),
      'error',
    );
  });
});
