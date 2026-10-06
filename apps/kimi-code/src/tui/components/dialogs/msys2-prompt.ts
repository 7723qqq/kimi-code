/**
 * Msys2Prompt — startup gate asking Windows users whether to install MSYS2
 * (full Linux command-line environment) and switch the shell to it.
 *
 * Mirrors TrustPromptComponent's container-replacement pattern: the host
 * mounts it over the editor, the user picks install/skip, and the host
 * tears it down.
 */

import { t } from '#/i18n';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

export type Msys2PromptChoice = 'install' | 'skip';

export interface Msys2PromptOptions {
  readonly onSelect: (choice: Msys2PromptChoice) => void;
  readonly onCancel: () => void;
}

export class Msys2PromptComponent extends ChoicePickerComponent {
  constructor(opts: Msys2PromptOptions) {
    const options: readonly ChoiceOption[] = [
      {
        value: 'install',
        label: t('tui.dialogs.msys2Prompt.install'),
        description: t('tui.dialogs.msys2Prompt.installDescription'),
      },
      {
        value: 'skip',
        label: t('tui.dialogs.msys2Prompt.skip'),
        description: t('tui.dialogs.msys2Prompt.skipDescription'),
      },
    ];
    super({
      title: t('tui.dialogs.msys2Prompt.title'),
      hint: t('tui.dialogs.msys2Prompt.hint'),
      options,
      onSelect: (value) => opts.onSelect(value as Msys2PromptChoice),
      onCancel: opts.onCancel,
    });
  }
}
