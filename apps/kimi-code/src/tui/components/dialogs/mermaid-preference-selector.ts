import { t } from '#/i18n';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

function getMermaidPreferenceOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'on',
      label: t('tui.dialogs.mermaidPreferenceSelector.on'),
      description: t('tui.dialogs.mermaidPreferenceSelector.onDescription'),
    },
    {
      value: 'off',
      label: t('tui.dialogs.mermaidPreferenceSelector.off'),
      description: t('tui.dialogs.mermaidPreferenceSelector.offDescription'),
    },
  ];
}

export interface MermaidPreferenceSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
}

export class MermaidPreferenceSelectorComponent extends ChoicePickerComponent {
  constructor(opts: MermaidPreferenceSelectorOptions) {
    super({
      title: t('tui.dialogs.mermaidPreferenceSelector.title'),
      options: [...getMermaidPreferenceOptions()],
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
