import { describe, expect, it, mock, spyOn } from 'bun:test';

import { applySurveyPreferenceChoice } from '#/tui/commands/config';
import * as tuiConfig from '#/tui/config';
import { darkColors } from '#/tui/theme/colors';

const mocks = {
  saveTuiConfig: spyOn(tuiConfig, 'saveTuiConfig').mockImplementation(async () => {}),
};

function makeHost(disableFeedbackSurvey: boolean) {
  return {
    state: {
      appState: {
        theme: 'auto' as const,
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' as const },
        upgrade: { autoInstall: true },
        disableFeedbackSurvey,
      },
      theme: { palette: darkColors },
    },
    setAppState: mock(),
    showStatus: mock(),
  };
}

describe('survey preference commands', () => {
  it('saves the opt-out to tui.toml and mirrors it into appState', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(false);

    await applySurveyPreferenceChoice(host, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ disableFeedbackSurvey: true }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ disableFeedbackSurvey: true });
    expect(host.showStatus).toHaveBeenCalledWith('Feedback survey disabled.');
  });

  it('re-enables the survey from an opt-out state', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(true);

    await applySurveyPreferenceChoice(host, true);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ disableFeedbackSurvey: false }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ disableFeedbackSurvey: false });
    expect(host.showStatus).toHaveBeenCalledWith('Feedback survey enabled.');
  });

  it('does not rewrite the config when the value is unchanged', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(false);

    await applySurveyPreferenceChoice(host, true);

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Feedback survey already enabled.');
  });

  it('reports a save failure without touching appState', async () => {
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost(false);

    await applySurveyPreferenceChoice(host, false);

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Failed to save session rating setting: disk full',
      'error',
    );
  });
});
