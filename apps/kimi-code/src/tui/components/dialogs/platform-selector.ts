import { GoogleOAuthManager, OPEN_PLATFORMS } from '@moonshot-ai/kimi-code-oauth';

import { t } from '#/i18n';
import { KIMI_CODE_GLOBAL_PLATFORM_VALUE } from '#/utils/region';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const KIMI_CODE_MAINLAND_CN_OPTION: ChoiceOption = {
  value: 'kimi-code',
  label: 'Kimi Code (kimi.com/code)',
};
const KIMI_CODE_GLOBAL_OPTION: ChoiceOption = {
  value: KIMI_CODE_GLOBAL_PLATFORM_VALUE,
  label: 'Kimi Code (kimi.ai/code)',
};
const GOOGLE_GEMINI_OAUTH_OPTION: ChoiceOption = {
  value: 'google-oauth',
  label: 'Google Gemini (OAuth · Browser Login)',
};

function platformOptions(): readonly ChoiceOption[] {
  const antigravity = GoogleOAuthManager.detectAntigravityCredentials();
  const options: ChoiceOption[] = [];

  if (antigravity.available) {
    options.push({
      value: 'google-antigravity-sync',
      label: `Google Antigravity (${antigravity.email ?? 'active user'} · 1-Click Sync)`,
    });
  }

  options.push(
    GOOGLE_GEMINI_OAUTH_OPTION,
    KIMI_CODE_MAINLAND_CN_OPTION,
    KIMI_CODE_GLOBAL_OPTION,
  );

  options.push(...OPEN_PLATFORMS.map((platform) => ({ value: platform.id, label: platform.name })));
  return options;
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
