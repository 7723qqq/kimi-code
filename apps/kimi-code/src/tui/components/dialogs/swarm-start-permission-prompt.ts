import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
} from './start-permission-prompt';
import { t } from '#/i18n';

export type SwarmStartPermissionChoice = 'auto' | 'yolo' | 'manual';

export interface SwarmStartPermissionPromptOptions {
  readonly onSelect: (choice: SwarmStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

const OPTIONS: readonly StartPermissionOption<SwarmStartPermissionChoice>[] = [
  {
    value: 'auto',
    label: t('tui.dialogs.swarmStartPermissionPrompt.optionAutoLabel'),
    description:
      'Best for swarm tasks. Tools are approved automatically and questions are skipped; only plans in Plan mode wait for your review.',
  },
  {
    value: 'yolo',
    label: t('tui.dialogs.swarmStartPermissionPrompt.optionYoloLabel'),
    description:
      'Tools are approved automatically. Kimi Code may still ask you questions.',
  },
  {
    value: 'manual',
    label: t('tui.dialogs.swarmStartPermissionPrompt.optionManualLabel'),
    description:
      t('tui.dialogs.swarmStartPermissionPrompt.optionManualDesc'),
  },
];

const NOTICE_LINES = [
  'Always Ask mode asks you before Kimi Code runs commands, edits files, or takes other risky actions, and can block swarm work while agents are running.',
  t('tui.dialogs.swarmStartPermissionPrompt.notice3'),
] as const;

export class SwarmStartPermissionPromptComponent extends StartPermissionPromptComponent<SwarmStartPermissionChoice> {
  constructor(opts: SwarmStartPermissionPromptOptions) {
    super({
      title: t('tui.dialogs.swarmStartPermissionPrompt.title'),
      noticeLines: NOTICE_LINES,
      options: OPTIONS,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
