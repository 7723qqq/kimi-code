import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';
import { permissionModeDescription, permissionModeDisplayName } from '#/tui/utils/permission-mode';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

function permissionOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'manual',
      label: permissionModeDisplayName('manual'),
      description: permissionModeDescription('manual'),
    },
    {
      value: 'yolo',
      label: permissionModeDisplayName('yolo'),
      description: permissionModeDescription('yolo'),
    },
    {
      value: 'auto',
      label: permissionModeDisplayName('auto'),
      description: permissionModeDescription('auto'),
    },
  ];
}

function isPermissionModeChoice(value: string): value is PermissionMode {
  return value === 'manual' || value === 'auto' || value === 'yolo';
}

export interface PermissionSelectorOptions {
  readonly currentValue: PermissionMode;
  readonly initialValue?: PermissionMode;
  readonly onSelect: (mode: PermissionMode) => void;
  readonly onCancel: () => void;
}

export class PermissionSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PermissionSelectorOptions) {
    super({
      title: t('tui.dialogs.permissionSelector.title'),
      options: [...permissionOptions()],
      currentValue: opts.currentValue,
      initialValue: opts.initialValue,
      onSelect: (value) => {
        if (isPermissionModeChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
