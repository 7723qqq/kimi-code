import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
  type StartPermissionPromptOptions,
} from './start-permission-prompt';
import { t } from '#/i18n';

export type GoalStartPermissionChoice = 'auto' | 'yolo' | 'manual' | 'cancel';

export interface GoalStartPermissionPromptOptions
  extends Pick<StartPermissionPromptOptions, 'layout'> {
  readonly mode: 'manual' | 'yolo';
  readonly onSelect: (choice: GoalStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

export const GOAL_START_MANUAL_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'auto',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionAutoLabel'),
    description:
      'Best if you want Kimi Code to keep working while you are away. Tools are approved automatically and questions are skipped; only plans in Plan mode wait for your review.',
  },
  {
    value: 'yolo',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionYoloLabel'),
    description:
      'Tools are approved automatically. Kimi Code may still ask you questions.',
  },
  {
    value: 'manual',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionManualLabel'),
    description:
      t('tui.dialogs.goalStartPermissionPrompt.optionManualDesc'),
  },
  {
    value: 'cancel',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionCancelLabel'),
    description: t('tui.dialogs.goalStartPermissionPrompt.optionCancelDesc'),
  },
];

export const GOAL_START_YOLO_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'auto',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionAutoLabel'),
    description:
      'Best if you want Kimi Code to keep working while you are away. Tools are approved automatically and questions are skipped; only plans in Plan mode wait for your review.',
  },
  {
    value: 'yolo',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionYoloKeepLabel'),
    description:
      'Tools stay approved automatically. Kimi Code may still ask you questions.',
  },
  {
    value: 'cancel',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionCancelLabel'),
    description: t('tui.dialogs.goalStartPermissionPrompt.optionCancelDesc'),
  },
];

export function goalStartOptions(mode: 'manual' | 'yolo'): readonly StartPermissionOption[] {
  return mode === 'yolo' ? GOAL_START_YOLO_OPTIONS : GOAL_START_MANUAL_OPTIONS;
}

const MANUAL_OPTIONS = GOAL_START_MANUAL_OPTIONS;

const YOLO_OPTIONS = GOAL_START_YOLO_OPTIONS;

const MANUAL_NOTICE_LINES = [
  'Always Ask mode asks you before Kimi Code runs commands, edits files, or takes other risky actions, and is not suitable for unattended goal work.',
  'You can go back without losing your command.',
] as const;

const YOLO_NOTICE_LINES = [
  'Ask When Needed mode approves tools automatically, but can still stop for questions.',
  t('tui.dialogs.goalStartPermissionPrompt.yoloNotice3'),
] as const;

export class GoalStartPermissionPromptComponent extends StartPermissionPromptComponent {
  constructor(opts: GoalStartPermissionPromptOptions) {
    super({
      title:
        opts.mode === 'yolo'
          ? t('tui.dialogs.goalStartPermissionPrompt.titleYolo')
          : t('tui.dialogs.goalStartPermissionPrompt.titleManual'),
      noticeLines: opts.mode === 'yolo' ? YOLO_NOTICE_LINES : MANUAL_NOTICE_LINES,
      options: opts.mode === 'yolo' ? YOLO_OPTIONS : MANUAL_OPTIONS,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
      layout: opts.layout,
    });
  }
}
