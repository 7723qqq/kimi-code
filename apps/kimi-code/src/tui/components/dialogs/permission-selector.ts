import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

function permissionOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'manual',
      label: 'Manual',
      description: t('tui.dialogs.permissionSelector.manualDesc'),
    },
    {
      value: 'yolo',
      label: 'YOLO',
      description: 'Auto-approve tool actions, but the agent may still ask questions.',
    },
    {
      value: 'auto',
      label: 'Auto',
      description: 'Fully autonomous — agent decides everything without asking.',
    },
  ];
}

function isPermissionModeChoice(value: string): value is PermissionMode {
  return value === 'manual' || value === 'auto' || value === 'yolo';
}

export interface PermissionSelectorOptions {
  readonly currentValue: PermissionMode;
  readonly onSelect: (mode: PermissionMode) => void;
  readonly onCancel: () => void;
}

export class PermissionSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PermissionSelectorOptions) {
    super({
      title: t('tui.dialogs.permissionSelector.title'),
      options: [...permissionOptions()],
      currentValue: opts.currentValue,
      onSelect: (value) => {
        if (isPermissionModeChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
