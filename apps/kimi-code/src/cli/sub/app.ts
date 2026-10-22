import { resolve } from 'node:path';
import type { Command } from 'commander';

import { t } from '#/i18n';
import { openUrl } from '#/utils/open-url';

export interface AppCommandDeps {
  readonly openUrl?: (url: string, onError?: (error: Error) => void) => void;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
  readonly setExitCode?: (code: number) => void;
}

export function registerAppCommand(program: Command, deps: AppCommandDeps = {}): void {
  const open = deps.openUrl ?? openUrl;
  const stderr = deps.stderr ?? process.stderr;
  const setExitCode =
    deps.setExitCode ??
    ((code: number): void => {
      process.exitCode = code;
    });
  program
    .command('app [path]')
    .description(t('cli.commandDescriptions.app'))
    .action((path?: string) => {
      const root = resolve(path ?? process.cwd());
      open(`kimi-code://open?root=${encodeURIComponent(root)}&new=1`, () => {
        stderr.write('Could not open Kimi Code desktop. Run `kimi install-desktop` to install it.\n');
        setExitCode(1);
      });
    });
}
