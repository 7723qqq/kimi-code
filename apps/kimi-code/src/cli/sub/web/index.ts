import type { Command } from 'commander';

import { t } from '#/i18n';

import { registerEnsureDaemonCommand } from './ensure-daemon';
import { registerLegacyKillCommand } from './legacy-kill';
import { registerRotateTokenCommand } from './rotate-token';
import { buildWebCommand } from './run';

export function registerWebCommand(program: Command): void {
  const web = buildWebCommand(
    program.command('web').description(t('cli.commandDescriptions.web')),
  );
  registerRotateTokenCommand(web);

  const server = buildWebCommand(
    program.command('server', { hidden: true }).description(t('cli.commandDescriptions.server')),
    { defaultOpen: false },
  );
  registerRotateTokenCommand(server);
  registerEnsureDaemonCommand(server);
  registerLegacyKillCommand(server);

  buildWebCommand(
    program.command('rc').alias('remote').description(t('cli.commandDescriptions.rc')),
    { forceRemoteControl: true },
  );
}
