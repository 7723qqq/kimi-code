import type { Command } from 'commander';

import { parseRegionFlag, runLoginFlow } from './login-flow';
import { t } from '#/i18n';

export function registerLoginCommand(parent: Command): void {
  parent
    .command('login')
    .description(t('cli.commandDescriptions.login'))
    .option(
      '--region <region>',
      t('cli.optionDescriptions.loginRegion'),
    )
    .action(async (opts: { region?: string }) => {
      await runLoginFlow({
        region: opts.region === undefined ? undefined : parseRegionFlag(opts.region),
      });
    });
}
