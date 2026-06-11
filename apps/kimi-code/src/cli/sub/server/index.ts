/**
 * `kimi server` parent command. Mounts:
 *   - `server run`                            (foreground)
 *   - `server install/uninstall/start/stop/restart/status` (OS service)
 *
 * The top-level `kimi web` alias is registered separately via
 * `registerWebAliasCommand` so it stays at the program root.
 */

import type { Command } from 'commander';

import { addLifecycleCommands } from './lifecycle';
import { buildRunCommand } from './run';
import { registerWebAliasCommand } from './web-alias';

export function registerServerCommand(program: Command): void {
  const server = program
    .command('server')
    .description('Run, install, and manage the local Kimi server (REST + WebSocket + web UI).');

  buildRunCommand(
    server.command('run').description('Run the Kimi server in the foreground.'),
    { defaultOpen: false },
  );

  addLifecycleCommands(server);

  registerWebAliasCommand(program);
}

export { registerWebAliasCommand };
