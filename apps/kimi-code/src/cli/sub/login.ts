import type { Command } from 'commander';

import { t } from '#/i18n';

import { parseRegionFlag, runLoginFlow } from './login-flow';

export function registerLoginCommand(parent: Command): void {
  parent
    .command('login')
    .description(t('cli.commandDescriptions.login'))
    .option('--region <region>', t('cli.optionDescriptions.loginRegion'))
    .option('--provider <provider>', t('cli.optionDescriptions.loginProvider'))
    .action(async (opts: { region?: string; provider?: string }) => {
      await runLoginFlow({
        region: opts.region === undefined ? undefined : parseRegionFlag(opts.region),
        provider: opts.provider,
      });
    });
}
