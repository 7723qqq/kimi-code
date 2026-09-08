/**
 * `kimi acp` sub-command.
 *
 * Starts the Agent Client Protocol (ACP) server backed directly by the
 * DI × Scope agent engine (`agent-core-v2`) over stdio, so ACP-compatible
 * clients can drive a kimi-code session.
 *
 * Wire-up:
 *  - `--login` pivots into the shared device-code login flow (the entry point
 *    ACP clients hit via the first-class `AuthMethodTerminal` path, re-invoking
 *    the agent binary with the advertised `args:['--login']`).
 *  - `KIMI_CODE_HOME` (if set) is forwarded into `authMethods[0].env` so the
 *    login subprocess writes its token under the same data root the server
 *    reads from, and `process.argv[1]` is advertised as the legacy
 *    `_meta['terminal-auth'].command` fallback.
 *
 * `@moonshot-ai/acp-server` (and its `agent-core-v2` engine) is loaded via a
 * lazy dynamic import so parsing the CLI does not initialize the ACP engine —
 * mirroring the `kimi server run` v2 routing in `#/cli/sub/server/run.ts`.
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
