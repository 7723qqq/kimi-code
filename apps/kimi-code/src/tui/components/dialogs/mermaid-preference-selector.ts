import { t } from '#/i18n';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

// Built per call, not at module scope: `t()` has to run under the active
// locale, and a module-level constant would freeze whichever locale happened
// to be installed when the module was first evaluated.
function mermaidPreferenceOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'on',
      label: 'On',
      description: t('tui.mermaidPreference.drawDiagram'),
    },
    {
      value: 'off',
      label: 'Off',
      description: t('tui.mermaidPreference.keepSource'),
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
      title: t('tui.dialogs.settingsSelector.mermaid'),
      options: [...mermaidPreferenceOptions()],
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
