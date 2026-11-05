import type { Command } from 'commander';

import { createCliTelemetryBootstrap } from '#/cli/telemetry';
import { createKimiCodeHostIdentity } from '#/cli/host-identity';

import { importBudget, importSessions, scanImportableSessions, sourceHomes } from './run-import';
import { ImportSessionsScreenComponent } from './screen';

export function registerImportSessionsCommand(
  parent: Command,
  run: () => Promise<number> = async () => {
    // The import screen pulls the harness and pi-tui; load it only when the
    // command actually runs so the CLI entry stays free of both.
    const { runImportSessionsCommand } = await import('./run-screen');
    return runImportSessionsCommand();
  },
): void {
  parent
    .command('import-sessions')
    .description(t('tui.messages.importSessions.cliDescription'))
    .action(async () => {
      process.exitCode = await run();
    });
}
