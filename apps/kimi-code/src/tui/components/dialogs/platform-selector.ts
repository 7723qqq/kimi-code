import { OPEN_PLATFORMS } from '@moonshot-ai/kimi-code-oauth';

import { t } from '#/i18n';
import { KIMI_CODE_GLOBAL_PLATFORM_VALUE } from '#/utils/region';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

// Built per call, not at module scope: `t()` has to run under the active
// locale, and a module-level constant would freeze whichever locale happened
// to be installed when the module was first evaluated.
function platformOptions(): readonly ChoiceOption[] {
  return [
    { value: 'kimi-code', label: t('tui.platformMainland') },
    { value: KIMI_CODE_GLOBAL_PLATFORM_VALUE, label: t('tui.platformGlobal') },
    ...OPEN_PLATFORMS.map((platform) => ({ value: platform.id, label: platform.name })),
  ];
}

export interface PlatformSelectorOptions {
  readonly onSelect: (platformId: string) => void;
  readonly onCancel: () => void;
}

export class PlatformSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PlatformSelectorOptions) {
    super({
      title: t('tui.dialogs.platformSelector.title'),
      options: [...platformOptions()],
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
