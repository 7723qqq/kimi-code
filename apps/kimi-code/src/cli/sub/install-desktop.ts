import type { Command } from 'commander';

import { kimiCodeOfficialInstallUrl } from '#/constant/app';
import { t } from '#/i18n';
import { openUrl } from '#/utils/open-url';

export interface InstallDesktopDeps {
  readonly stdout?: Pick<NodeJS.WriteStream, 'write'>;
  readonly openUrl?: (url: string) => void;
}

export function registerInstallDesktopCommand(
  program: Command,
  deps: InstallDesktopDeps = {},
): void {
  const stdout = deps.stdout ?? process.stdout;
  const open = deps.openUrl ?? openUrl;
  const openDesktopAppPage = (): void => {
    const url = kimiCodeOfficialInstallUrl();
    stdout.write(`${url}\n`);
    open(url);
  };

  program
    .command('install-desktop')
    .description(t('cli.commandDescriptions.installDesktop'))
    .action(openDesktopAppPage);

  program.command('install-app', { hidden: true }).action(openDesktopAppPage);
}
