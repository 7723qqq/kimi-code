/**
 * `kimi web` — thin alias for `kimi server run --open`.
 *
 * Lives at the top level of the program (not under `server`) so users can keep
 * typing the short form. Identical to `run` except `--open` defaults to true.
 */

import type { Command } from 'commander';

import { buildRunCommand } from './run';

export function registerWebAliasCommand(program: Command): void {
  buildRunCommand(
    program
      .command('web')
      .description('Open the Kimi web UI (alias of `kimi server run --open`).'),
    { defaultOpen: true },
  );
}
