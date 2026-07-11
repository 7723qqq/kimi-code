import type { Locale } from '#/i18n';
import { t } from '#/i18n';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const LOCALE_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'en',
    label: 'English',
    description: 'English interface language.',
  },
  {
    value: 'zh',
    label: '中文',
    description: '中文界面语言。',
  },
];

function isLocaleChoice(value: string): value is Locale {
  return value === 'en' || value === 'zh';
}

export interface LocaleSelectorOptions {
  readonly currentValue: Locale;
  readonly onSelect: (locale: Locale) => void;
  readonly onCancel: () => void;
}

export class LocaleSelectorComponent extends ChoicePickerComponent {
  constructor(opts: LocaleSelectorOptions) {
    super({
      title: t('tui.dialogs.localeSelector.title'),
      options: [...LOCALE_OPTIONS],
      currentValue: opts.currentValue,
      onSelect: (value) => {
        if (isLocaleChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}