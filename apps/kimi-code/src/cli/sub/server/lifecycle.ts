/**
 * `kimi server install/uninstall/start/stop/restart/status`.
 *
 * Phase 2 lands the CLI shape; the lifecycle calls into the platform service
 * manager from `@moonshot-ai/server`, which is filled in by Phase 3+.
 *
 * The Commander wiring here mirrors `addGatewayServiceCommands` from
 * `../openclaw/src/cli/daemon-cli/register-service-commands.ts:58`.
 */

import type { Command } from 'commander';

import {
  ServiceUnsupportedError,
  resolveServiceManager,
  type InstallArgs,
  type ServiceManager,
  type ServiceStatus,
} from '@moonshot-ai/server';

import {
  DEFAULT_LOG_LEVEL,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  parseLogLevel,
  parsePort,
  VALID_LOG_LEVELS,
} from './shared';

export interface InstallCliOptions {
  host?: string;
  port?: string;
  logLevel?: string;
  force?: boolean;
  json?: boolean;
}

export interface JsonCliOptions {
  json?: boolean;
}

export interface LifecycleCommandDeps {
  resolveManager(): ServiceManager;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

const DEFAULT_DEPS: LifecycleCommandDeps = {
  resolveManager: resolveServiceManager,
  stdout: process.stdout,
  stderr: process.stderr,
};

/** Mount install/uninstall/start/stop/restart/status under a parent command. */
export function addLifecycleCommands(parent: Command, deps: LifecycleCommandDeps = DEFAULT_DEPS): void {
  parent
    .command('install')
    .description('Install the Kimi server as an OS-managed service (launchd/systemd/schtasks).')
    .option('--host <host>', `Bind host (default ${DEFAULT_SERVER_HOST})`, DEFAULT_SERVER_HOST)
    .option('--port <port>', `Bind port (default ${DEFAULT_SERVER_PORT})`, String(DEFAULT_SERVER_PORT))
    .option(
      '--log-level <level>',
      `Log level: ${VALID_LOG_LEVELS.join('|')} (default ${DEFAULT_LOG_LEVEL})`,
      DEFAULT_LOG_LEVEL,
    )
    .option('--force', 'Reinstall and overwrite if already installed', false)
    .option('--json', 'Output JSON', false)
    .action(async (opts: InstallCliOptions) => {
      await runLifecycle(deps, opts.json === true, async (mgr) => {
        const args: InstallArgs = {
          host: opts.host ?? DEFAULT_SERVER_HOST,
          port: parsePort(opts.port, '--port', DEFAULT_SERVER_PORT),
          logLevel: parseLogLevel(opts.logLevel),
          force: opts.force === true,
        };
        const result = await mgr.install(args);
        return {
          ok: true,
          action: 'install',
          status: result.status,
          plistPath: result.plistPath,
          unitPath: result.unitPath,
          taskName: result.taskName,
          message: result.message,
        };
      });
    });

  parent
    .command('uninstall')
    .description('Uninstall the Kimi server service.')
    .option('--json', 'Output JSON', false)
    .action(async (opts: JsonCliOptions) => {
      await runLifecycle(deps, opts.json === true, async (mgr) => {
        const result = await mgr.uninstall();
        return { ok: result.ok, action: 'uninstall', message: result.message };
      });
    });

  parent
    .command('start')
    .description('Start the Kimi server service.')
    .option('--json', 'Output JSON', false)
    .action(async (opts: JsonCliOptions) => {
      await runLifecycle(deps, opts.json === true, async (mgr) => {
        const result = await mgr.start();
        return { ok: result.ok, action: 'start', message: result.message };
      });
    });

  parent
    .command('stop')
    .description('Stop the Kimi server service.')
    .option('--json', 'Output JSON', false)
    .action(async (opts: JsonCliOptions) => {
      await runLifecycle(deps, opts.json === true, async (mgr) => {
        const result = await mgr.stop();
        return { ok: result.ok, action: 'stop', message: result.message };
      });
    });

  parent
    .command('restart')
    .description('Restart the Kimi server service.')
    .option('--json', 'Output JSON', false)
    .action(async (opts: JsonCliOptions) => {
      await runLifecycle(deps, opts.json === true, async (mgr) => {
        const result = await mgr.restart();
        return { ok: result.ok, action: 'restart', message: result.message };
      });
    });

  parent
    .command('status')
    .description('Show Kimi server service status and connectivity.')
    .option('--json', 'Output JSON', false)
    .action(async (opts: JsonCliOptions) => {
      await runLifecycle(deps, opts.json === true, async (mgr) => {
        const status: ServiceStatus = await mgr.status();
        return { ok: true, action: 'status', ...status };
      });
    });
}

async function runLifecycle(
  deps: LifecycleCommandDeps,
  json: boolean,
  body: (mgr: ServiceManager) => Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    const mgr = deps.resolveManager();
    const result = await body(mgr);
    if (json) {
      deps.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    deps.stdout.write(formatHuman(result));
  } catch (error) {
    if (error instanceof ServiceUnsupportedError) {
      const payload = {
        ok: false,
        action: 'unsupported',
        platform: error.platform,
        message: error.message,
      };
      if (json) {
        deps.stdout.write(`${JSON.stringify(payload)}\n`);
      } else {
        deps.stderr.write(`${error.message}\n`);
      }
      process.exit(2);
      return;
    }
    if (json) {
      deps.stdout.write(
        `${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })}\n`,
      );
    } else {
      deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(1);
  }
}

function formatHuman(result: Record<string, unknown>): string {
  const rawAction = result['action'];
  const action = typeof rawAction === 'string' ? rawAction : 'action';
  const rawMessage = result['message'];
  const message = typeof rawMessage === 'string' ? `: ${rawMessage}` : '';
  return `${action}${message}\n`;
}
