import { kimiCodeOfficialInstallUrl } from '#/constant/app';
import { t } from '#/i18n';
import { openUrl } from '#/utils/open-url';

import type { SlashCommandHost } from './dispatch';

export async function handleDesktopCommand(host: SlashCommandHost): Promise<void> {
  const url = kimiCodeOfficialInstallUrl();
  host.showStatus(t('tui.messages.desktopOpenedInBrowser', { url }));
  openUrl(url);
}
