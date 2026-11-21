import type { Command } from 'commander';

import { kimiCodeOfficialInstallUrl } from '#/constant/app';
import { openUrl } from '#/utils/open-url';
import { t } from '#/i18n';

function openDesktopAppPage(): void {
  const url = kimiCodeOfficialInstallUrl();
  process.stdout.write(`${url}\n`);
  openUrl(url);
}

export function registerInstallDesktopCommand(program: Command): void {
  program
    .command('install-desktop')
    .description(t('cli.commandDescriptions.installDesktop'))
    .action(openDesktopAppPage);

  program.command('install-app', { hidden: true }).action(openDesktopAppPage);
}
