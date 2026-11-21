import type { Command } from 'commander';

import { getVersion } from '#/cli/version';
import { KIMI_CODE_HOME_ENV } from '#/constant/app';
import { getDataDir } from '#/utils/paths';

import { parseRegionFlag, runLoginFlow } from './login-flow';
import { t } from '#/i18n';

export function registerAcpCommand(parent: Command): void {
  parent
    .command('acp')
    .description(t('cli.commandDescriptions.acp'))
    .option(
      '--login',
      t('cli.optionDescriptions.acpLogin'),
      false,
    )
    .option('--region <region>', t('cli.optionDescriptions.acpRegion'))
    .action(async (opts: { login?: boolean; region?: string }) => {
      const rootOptions = parent.opts<{ environment?: string; environmentCwd?: string }>();
      if (rootOptions.environment !== undefined) {
        process.stderr.write(
          `error: Cannot use --environment with 'acp': ACP sessions run in the ACP client's own environment.\n`,
        );
        process.exit(1);
      }
      if (rootOptions.environmentCwd !== undefined) {
        process.stderr.write(
          `error: Cannot use --environment-cwd with 'acp': ACP sessions run in the ACP client's own environment.\n`,
        );
        process.exit(1);
      }
      if (opts.login === true) {
        await runLoginFlow({
          region: opts.region === undefined ? undefined : parseRegionFlag(opts.region),
        });
        return;
      }
      const sandboxHome = process.env[KIMI_CODE_HOME_ENV];
      const terminalAuthEnv =
        sandboxHome !== undefined && sandboxHome.length > 0
          ? { [KIMI_CODE_HOME_ENV]: sandboxHome }
          : undefined;
      const legacyCommand = process.argv[1];
      try {
        const { runAcpServer } = await import('@moonshot-ai/acp-server');
        await runAcpServer({
          homeDir: getDataDir(),
          agentInfo: { name: 'Kimi Code CLI', version: getVersion() },
          ...(terminalAuthEnv ? { terminalAuthEnv } : {}),
          ...(legacyCommand !== undefined && legacyCommand.length > 0
            ? { terminalAuthLegacyCommand: legacyCommand }
            : {}),
        });
        process.exit(0);
      } catch (error) {
        process.stderr.write(`acp server: fatal error: ${String(error)}\n`);
        process.exit(1);
      }
    });
}
