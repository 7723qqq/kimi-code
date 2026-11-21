import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import { listCustomThemesSync } from '#/tui/theme/custom-theme-loader';
import type { ThemeName } from '#/tui/theme/index';
import { t } from '#/i18n';

const THEME_OPTIONS: readonly ChoiceOption[] = [
  { value: 'auto', label: t('tui.dialogs.themeSelector.auto') },
  { value: 'dark', label: t('tui.dialogs.themeSelector.dark') },
  { value: 'light', label: t('tui.dialogs.themeSelector.light') },
];

export interface ThemeSelectorOptions {
  readonly currentValue: ThemeName;
  readonly onSelect: (theme: ThemeName) => void;
  readonly onCancel: () => void;
}

export class ThemeSelectorComponent extends ChoicePickerComponent {
  constructor(opts: ThemeSelectorOptions) {
    const customThemes = listCustomThemesSync();
    const options: ChoiceOption[] = [
      ...THEME_OPTIONS,
      ...customThemes.map((name) => ({ value: name, label: `Custom: ${name}` })),
    ];
    super({
      title: t('tui.dialogs.themeSelector.title'),
      options,
      currentValue: opts.currentValue,
      onSelect: (value) => {
        opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
