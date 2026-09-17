/**
 * `kimi acp` sub-command.
 *
 * Spawns the native `kimi-agent-cli --acp` process, which implements the Agent
 * Client Protocol (ACP) server over stdio in Rust (`packages/kimi-agent/src/acp/`),
 * so ACP-compatible clients can drive a kimi-code session. The TypeScript side
 * only locates the binary and hands it the terminal.
 *
 * `--login` pivots into the shared device-code login flow instead of starting
 * the server.
 */

import { spawn } from 'node:child_process';
import type { Command } from 'commander';

import { findRustAgentBinary } from '#/cli/sub/web/rust-server-runner';
import { t } from '#/i18n';
import { getDataDir } from '#/utils/paths';

import { parseRegionFlag, runLoginFlow } from './login-flow';

export function registerAcpCommand(parent: Command): void {
  parent
    .command('acp')
    .description('Run kimi-code as an Agent Client Protocol (ACP) server over stdio.')
    .option(
      '--login',
      t('cli.optionDescriptions.acpLogin'),
      false,
    )
    .option('--region <region>', 'Login region used together with --login: "mainland-cn" (kimi.com) or "global" (kimi.ai).')
    .action(async (opts: { login?: boolean; region?: string }) => {
      if (opts.login === true) {
        await runLoginFlow({
          region: opts.region === undefined ? undefined : parseRegionFlag(opts.region),
        });
        return;
      }

      const rustBin = findRustAgentBinary();
      if (rustBin === undefined) {
        process.stderr.write(
          'acp server: native rust binary (kimi-agent-cli) not found. Please build the native engine first with "bun run build:packages" or set KIMI_AGENT_BIN.\n',
        );
        process.exit(1);
      }

      const child = spawn(rustBin, ['--acp', '--data-dir', getDataDir()], {
        stdio: 'inherit',
        env: process.env,
      });
      child.on('exit', (code) => process.exit(code ?? 0));
    });
}
