import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';
import { t } from '#/i18n';

const MERMAID_PREFERENCE_OPTIONS: readonly ChoiceOption[] = [
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

export interface MermaidPreferenceSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
}

export class MermaidPreferenceSelectorComponent extends ChoicePickerComponent {
  constructor(opts: MermaidPreferenceSelectorOptions) {
    super({
      title: t('tui.dialogs.mermaidPreferenceSelector.title'),
      options: [...MERMAID_PREFERENCE_OPTIONS],
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
