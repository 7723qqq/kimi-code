import { t } from '#/i18n';

import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
} from './start-permission-prompt';

export type HelloWorldStartPermissionChoice = 'auto' | 'yolo' | 'manual';

export interface HelloWorldStartPermissionPromptOptions {
  readonly onSelect: (choice: HelloWorldStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

function helloWorldOptions(): readonly StartPermissionOption<HelloWorldStartPermissionChoice>[] {
  return [
    {
      value: 'auto',
      label: t('tui.dialogs.helloWorldStartPermissionPrompt.optionAutoLabel'),
      description: t('tui.dialogs.helloWorldStartPermissionPrompt.optionAutoDesc'),
    },
    {
      value: 'yolo',
      label: t('tui.dialogs.helloWorldStartPermissionPrompt.optionYoloLabel'),
      description: t('tui.dialogs.helloWorldStartPermissionPrompt.optionYoloDesc'),
    },
    {
      value: 'manual',
      label: t('tui.dialogs.helloWorldStartPermissionPrompt.optionManualLabel'),
      description: t('tui.dialogs.helloWorldStartPermissionPrompt.optionManualDesc'),
    },
  ];
}

function helloWorldNoticeLines(): readonly string[] {
  return [
    t('tui.dialogs.helloWorldStartPermissionPrompt.notice1'),
    t('tui.dialogs.helloWorldStartPermissionPrompt.notice2'),
    t('tui.dialogs.helloWorldStartPermissionPrompt.notice3'),
  ];
}

export class HelloWorldStartPermissionPromptComponent extends StartPermissionPromptComponent<HelloWorldStartPermissionChoice> {
  constructor(opts: HelloWorldStartPermissionPromptOptions) {
    super({
      title: t('tui.dialogs.helloWorldStartPermissionPrompt.title'),
      noticeLines: helloWorldNoticeLines(),
      options: helloWorldOptions(),
      initialValue: 'manual',
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
