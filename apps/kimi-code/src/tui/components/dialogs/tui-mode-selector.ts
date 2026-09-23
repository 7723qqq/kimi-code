import { t } from '#/i18n';

import type { TuiMode } from '../../config';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

function getTuiModeOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'regular',
      label: t('tui.dialogs.tuiModeSelector.regular'),
      description: t('tui.dialogs.tuiModeSelector.regularDesc'),
    },
    {
      value: 'fullscreen',
      label: t('tui.dialogs.tuiModeSelector.fullscreen'),
      description: t('tui.dialogs.tuiModeSelector.fullscreenDesc'),
    },
  ];
}

export interface TuiModeSelectorOptions {
  readonly currentValue: TuiMode;
  readonly onSelect: (value: TuiMode) => void;
  readonly onCancel: () => void;
}

export class TuiModeSelectorComponent extends ChoicePickerComponent {
  constructor(opts: TuiModeSelectorOptions) {
    super({
      title: t('tui.dialogs.tuiModeSelector.title'),
      options: [...getTuiModeOptions()],
      currentValue: opts.currentValue,
      onSelect: (value) => {
        if (value === 'regular' || value === 'fullscreen') opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
