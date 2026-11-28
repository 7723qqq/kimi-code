import { type Command, Option } from 'commander';

import { t } from '#/i18n';

import type { WebCliOptions } from './run';
import {
  DEFAULT_LAN_HOST,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  VALID_LOG_LEVELS,
} from './shared';

/** Build the `web` command, mounting the runner action on `cmd` itself. */
export function buildWebCommand(
  cmd: Command,
  opts: { forceRemoteControl?: boolean; defaultOpen?: boolean } = {},
): Command {
  const forceRemoteControl = opts.forceRemoteControl === true;
  const defaultOpen = opts.defaultOpen ?? true;
  const withServerOptions = cmd
    .option(
      '--port <port>',
      t('cli.optionDescriptions.serverRunOptionPort', { port: String(DEFAULT_SERVER_PORT) }),
      String(DEFAULT_SERVER_PORT),
    )
    .option(
      '--host [host]',
      t('cli.optionDescriptions.serverRunOptionHost', {
        host: DEFAULT_SERVER_HOST,
        lanHost: DEFAULT_LAN_HOST,
      }),
    )
    .option('--allowed-host <host...>', t('cli.optionDescriptions.serverRunOptionAllowedHost'))
    .option('--insecure-no-tls', t('cli.optionDescriptions.serverRunOptionInsecureNoTls'), true)
    .option(
      '--allow-remote-shutdown',
      t('cli.optionDescriptions.serverRunOptionAllowRemoteShutdown'),
      false,
    )
    .option(
      '--dangerous-bypass-auth',
      t('cli.optionDescriptions.serverRunOptionDangerousBypassAuth'),
      false,
    )
    .option(
      '--log-level <level>',
      t('cli.optionDescriptions.serverRunOptionLogLevel', { levels: VALID_LOG_LEVELS.join('|') }),
    )
    .option('--debug-endpoints', t('cli.optionDescriptions.serverRunOptionDebugEndpoints'), false)
    .option('--web-title <title>', t('cli.optionDescriptions.serverRunOptionWebTitle'));
  withServerOptions.addOption(new Option('--socket <path>').hideHelp());
  withServerOptions.addOption(new Option('--managed-by <owner>').hideHelp());
  if (!forceRemoteControl) {
    withServerOptions.addOption(
      new Option(
        '--rc, --remote-control',
        t('cli.optionDescriptions.serverRunOptionRemoteControl'),
      ).default(false),
    );
    withServerOptions.option(
      '--json',
      t('cli.optionDescriptions.serverRunOptionJson'),
      false,
    );
  }
  if (defaultOpen) {
    withServerOptions.option(
      '--no-open',
      t('cli.optionDescriptions.serverRunOptionNoOpen'),
      true,
    );
  } else {
    withServerOptions.option(
      '--open',
      t('cli.optionDescriptions.serverRunOptionOpen'),
      false,
    );
    withServerOptions.addOption(new Option('--no-open').hideHelp());
  }
  return withServerOptions
    .action(async (cliOpts: WebCliOptions) => {
      try {
        const { handleWebCommand } = await import('./run');
        await handleWebCommand(
          forceRemoteControl ? { ...cliOpts, remoteControl: true } : cliOpts,
        );
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}
