import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';
import { t } from '#/i18n';

const SURVEY_PREFERENCE_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'on',
    label: t('tui.dialogs.surveyPreferenceSelector.on'),
    description: t('tui.dialogs.surveyPreferenceSelector.onDescription'),
  },
  {
    value: 'off',
    label: t('tui.dialogs.surveyPreferenceSelector.off'),
    description: t('tui.dialogs.surveyPreferenceSelector.offDescription'),
  },
];

export interface SurveyPreferenceSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
}

export class SurveyPreferenceSelectorComponent extends ChoicePickerComponent {
  constructor(opts: SurveyPreferenceSelectorOptions) {
    super({
      title: t('tui.dialogs.surveyPreferenceSelector.title'),
      options: [...SURVEY_PREFERENCE_OPTIONS],
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
