import { t } from '#/i18n';

import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
} from './start-permission-prompt';

export type GoalStartPermissionChoice = 'auto' | 'yolo' | 'manual' | 'cancel';

export interface GoalStartPermissionPromptOptions {
  readonly mode: 'manual' | 'yolo';
  readonly onSelect: (choice: GoalStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

export function goalManualOptions(): readonly StartPermissionOption[] {
  return [
    {
      value: 'auto',
      label: t('tui.dialogs.goalStartPermissionPrompt.optionAutoLabel'),
      description: t('tui.dialogs.goalStartPermissionPrompt.optionAutoDesc'),
    },
    {
      value: 'yolo',
      label: t('tui.dialogs.goalStartPermissionPrompt.optionYoloLabel'),
      description: t('tui.dialogs.goalStartPermissionPrompt.optionYoloDesc'),
    },
    {
      value: 'manual',
      label: t('tui.dialogs.goalStartPermissionPrompt.optionManualLabel'),
      description: t('tui.dialogs.goalStartPermissionPrompt.optionManualDesc'),
    },
    {
      value: 'cancel',
      label: t('tui.dialogs.goalStartPermissionPrompt.optionCancelLabel'),
      description: t('tui.dialogs.goalStartPermissionPrompt.optionCancelDesc'),
    },
  ];
}

export function goalYoloOptions(): readonly StartPermissionOption[] {
  return [
    {
      value: 'auto',
      label: t('tui.dialogs.goalStartPermissionPrompt.optionAutoLabel'),
      description: t('tui.dialogs.goalStartPermissionPrompt.optionAutoDesc'),
    },
    {
      value: 'yolo',
      label: t('tui.dialogs.goalStartPermissionPrompt.optionYoloKeepLabel'),
      description: t('tui.dialogs.goalStartPermissionPrompt.optionYoloKeepDesc'),
    },
    {
      value: 'cancel',
      label: t('tui.dialogs.goalStartPermissionPrompt.optionCancelLabel'),
      description: t('tui.dialogs.goalStartPermissionPrompt.optionCancelDesc'),
    },
  ];
}

export function goalStartOptions(mode: 'manual' | 'yolo'): readonly StartPermissionOption[] {
  return mode === 'yolo' ? goalYoloOptions() : goalManualOptions();
}

function manualNoticeLines(): readonly string[] {
  return [
    t('tui.dialogs.goalStartPermissionPrompt.notice1'),
    t('tui.dialogs.goalStartPermissionPrompt.notice2'),
    t('tui.dialogs.goalStartPermissionPrompt.notice3'),
  ];
}

function yoloNoticeLines(): readonly string[] {
  return [
    t('tui.dialogs.goalStartPermissionPrompt.yoloNotice1'),
    t('tui.dialogs.goalStartPermissionPrompt.yoloNotice2'),
    t('tui.dialogs.goalStartPermissionPrompt.yoloNotice3'),
  ];
}

export class GoalStartPermissionPromptComponent extends StartPermissionPromptComponent {
  constructor(opts: GoalStartPermissionPromptOptions) {
    super({
      title:
        opts.mode === 'yolo'
          ? t('tui.dialogs.goalStartPermissionPrompt.titleYolo')
          : t('tui.dialogs.goalStartPermissionPrompt.titleManual'),
      noticeLines: opts.mode === 'yolo' ? yoloNoticeLines() : manualNoticeLines(),
      options: opts.mode === 'yolo' ? goalYoloOptions() : goalManualOptions(),
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
