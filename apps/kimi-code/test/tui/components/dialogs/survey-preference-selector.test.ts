import { describe, expect, it, vi } from 'vitest';

import { SurveyPreferenceSelectorComponent } from '#/tui/components/dialogs/survey-preference-selector';

// The real `t` goes through the native Rust engine, which is not loaded in
// tests, so it would hand back raw keys. Stub the strings this file asserts on.
vi.mock('#/i18n', () => ({
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
  setLocale: vi.fn(),
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
