import type { Command } from 'commander';

import { t } from '#/i18n';

export interface MigrateCommandOptions {
  readonly run: boolean;
  readonly configOnly: boolean;
}

export function registerMigrateCommand(
  parent: Command,
  onMigrate: (options: MigrateCommandOptions) => void,
): void {
  parent
    .command('migrate')
    .description(t('cli.commandDescriptions.migrate'))
    .option('--run', t('cli.optionDescriptions.migrateRun'), false)
    .option('--config-only', t('cli.optionDescriptions.migrateConfigOnly'), false)
    .action((options: { run?: boolean; configOnly?: boolean }) => {
      onMigrate({ run: options.run === true, configOnly: options.configOnly === true });
    });
}
