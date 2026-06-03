/**
 * `kimi acp` sub-command.
 *
 * Starts the Agent Client Protocol (ACP) server over stdio so that
 * ACP-compatible clients (editors, IDEs, custom front-ends) can drive
 * a kimi-code session.
 *
 * Wire-up:
 *  - A {@link KimiHarness} is constructed with the kimi-code host identity
 *    and a dedicated `uiMode: 'acp'` so downstream telemetry can
 *    distinguish ACP sessions from the TUI.
 *  - {@link runAcpServer} owns the JSON-RPC stdio bridge and redirects
 *    rogue `console.*` traffic to stderr.
 *  - On stream close or unhandled error the process exits with the
 *    appropriate code.
 */

import type { Command } from 'commander';

import { runAcpServer } from '@moonshot-ai/acp-adapter';
import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { createKimiCodeHostIdentity } from '#/cli/version';

export function registerAcpCommand(parent: Command): void {
  parent
    .command('acp')
    .description('Run kimi-code as an Agent Client Protocol (ACP) server over stdio.')
    .action(async () => {
      const identity = createKimiCodeHostIdentity();
      const harness = createKimiHarness({
        identity,
        uiMode: 'acp',
      });
      try {
        await runAcpServer(harness);
        process.exit(0);
      } catch (err) {
        process.stderr.write(`acp server: fatal error: ${String(err)}\n`);
        process.exit(1);
      }
    });
}
