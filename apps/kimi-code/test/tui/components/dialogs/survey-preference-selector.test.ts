import { describe, expect, it, mock } from 'bun:test';

import { SurveyPreferenceSelectorComponent } from '#/tui/components/dialogs/survey-preference-selector';

// The real `t` resolves against the bundled locale trees, which tests do not
// load, so it would hand back raw keys. Stub the strings this file asserts on.
void mock.module('#/i18n', () => ({
  t: (key: string) =>
    (
      {
        'tui.dialogs.surveyPreferenceSelector.title': 'Feedback survey',
        'tui.dialogs.surveyPreferenceSelector.on': 'On',
        'tui.dialogs.surveyPreferenceSelector.off': 'Off',
        'tui.dialogs.surveyPreferenceSelector.onDescription':
          'Show the occasional rating prompt above the editor.',
        'tui.dialogs.surveyPreferenceSelector.offDescription': 'Never show the rating prompt.',
      } as Record<string, string>
    )[key] ?? key,
  setLocale: mock(),
  getLocale: () => 'en',
}));

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

describe('SurveyPreferenceSelectorComponent', () => {
  it('maps the current preference onto the picker options', () => {
    const selected: boolean[] = [];
    const enabledPicker = new SurveyPreferenceSelectorComponent({
      currentValue: true,
      onSelect: (value) => selected.push(value),
      onCancel: () => {},
    });
    const disabledPicker = new SurveyPreferenceSelectorComponent({
      currentValue: false,
      onSelect: (value) => selected.push(value),
      onCancel: () => {},
    });

    expect(strip(enabledPicker.render(60).join('\n'))).toContain('Feedback survey');
    expect(strip(disabledPicker.render(60).join('\n'))).toContain('Off');

    enabledPicker.handleInput('\r');
    expect(selected).toEqual([true]);
    disabledPicker.handleInput('\r');
    expect(selected).toEqual([true, false]);
  });
});
