import { kimiCodeOfficialInstallUrl } from '#/constant/app';
import { openUrl } from '#/utils/open-url';

import type { SlashCommandHost } from './dispatch';
import { t } from '#/i18n';

export async function handleDesktopCommand(host: SlashCommandHost): Promise<void> {
  const url = kimiCodeOfficialInstallUrl();
  host.showStatus(t('tui.commands.desktop.openedInBrowser', { p1: url }));
  openUrl(url);
}
