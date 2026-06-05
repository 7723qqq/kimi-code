/**
 * `kimi daemon` sub-command.
 *
 * Boots the local REST + WebSocket daemon. Walking-skeleton scope: only
 * `GET /v1/healthz`. SDK / WS / DI wiring lives in later commits.
 */

import type { Command } from 'commander';

import { startDaemon, type DaemonLogLevel } from '@moonshot-ai/daemon';

import { createKimiCodeHostIdentity, getVersion } from '../version';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7878;
const DEFAULT_LOG_LEVEL: DaemonLogLevel = 'info';
const VALID_LOG_LEVELS: readonly DaemonLogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

interface DaemonCliOptions {
  host?: string;
  port?: string;
  logLevel?: string;
}

export function registerDaemonCommand(parent: Command): void {
  parent
    .command('daemon')
    .description('Run the local kimi-code daemon (REST + WebSocket).')
    .option('--host <host>', `Bind host (default ${DEFAULT_HOST})`, DEFAULT_HOST)
    .option('--port <port>', `Bind port (default ${DEFAULT_PORT})`, String(DEFAULT_PORT))
    .option(
      '--log-level <level>',
      `Log level: ${VALID_LOG_LEVELS.join('|')} (default ${DEFAULT_LOG_LEVEL})`,
      DEFAULT_LOG_LEVEL,
    )
    .action(async (opts: DaemonCliOptions) => {
      const host = opts.host ?? DEFAULT_HOST;
      const port = parsePort(opts.port);
      const logLevel = parseLogLevel(opts.logLevel);

      // Identify this process to the managed Kimi-for-Coding endpoint
      // as a real Coding Agent — same `kimi-code-cli/<ver>` UA + X-Msh-*
      // device-identity headers the in-process TUI path sends via
      // `createKimiHarness`. Without this the upstream returns 40340
      // ("only available for Coding Agents such as Kimi CLI, …")
      // because HarnessBridge would otherwise forward fetch's default
      // User-Agent. `HarnessBridge` reads `identity.version` for both
      // the headers and KimiCore's `appVersion`, so we don't need to
      // pass `appVersion` separately.
      const version = getVersion();
      const running = await startDaemon({
        host,
        port,
        logLevel,
        bridgeOptions: {
          identity: createKimiCodeHostIdentity(version),
        },
      });

      const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        running.logger.info({ signal }, 'daemon shutting down');
        try {
          await running.close();
          process.exit(0);
        } catch (error) {
          running.logger.error(
            { err: error instanceof Error ? error : new Error(String(error)) },
            'daemon shutdown error',
          );
          process.exit(1);
        }
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    process.stderr.write(`error: invalid --port value: ${raw}\n`);
    process.exit(1);
  }
  return n;
}

function parseLogLevel(raw: string | undefined): DaemonLogLevel {
  if (raw === undefined) return DEFAULT_LOG_LEVEL;
  if ((VALID_LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as DaemonLogLevel;
  }
  process.stderr.write(
    `error: invalid --log-level value: ${raw} (allowed: ${VALID_LOG_LEVELS.join(', ')})\n`,
  );
  process.exit(1);
}
