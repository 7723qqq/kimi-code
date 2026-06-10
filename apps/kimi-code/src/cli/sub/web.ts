/**
 * `kimi web` sub-command.
 *
 * Opens the daemon-hosted Kimi Code web UI. By default it ensures the local
 * daemon is running in the background first. When `--daemon-host` is provided,
 * that daemon is treated as the complete web/API host and is opened directly.
 */

import type { Command } from 'commander';

import { openUrl as defaultOpenUrl } from '#/utils/open-url';

import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_ORIGIN,
  DEFAULT_DAEMON_PORT,
  ensureDaemonRunning,
  parsePort,
  type EnsureDaemonResult,
} from './daemon';

export interface WebCliOptions {
  host?: string;
  port?: string;
  daemonHost?: string;
  open?: boolean;
}

export interface WebCommandDeps {
  ensureDaemonRunning(options: {
    host: string;
    port: number;
    logLevel: 'info';
    debugEndpoints: false;
  }): Promise<EnsureDaemonResult>;
  ensureDaemonWebReady(origin: string): Promise<void>;
  openUrl(url: string): void;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export function registerWebCommand(parent: Command): void {
  parent
    .command('web')
    .description('Open the daemon-hosted Kimi Code web UI.')
    .option(
      '--host <host>',
      `Bind host when starting the local daemon (default ${DEFAULT_DAEMON_HOST})`,
    )
    .option(
      '--port <port>',
      `Port when starting the local daemon (default ${DEFAULT_DAEMON_PORT})`,
    )
    .option(
      '--daemon-host <url>',
      `Daemon URL to open instead of starting the local daemon (default ${DEFAULT_DAEMON_ORIGIN})`,
    )
    .option('--no-open', 'Do not open the web UI in the default browser.')
    .action(async (opts: WebCliOptions) => {
      try {
        await handleWebCommand(opts);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

export async function handleWebCommand(
  opts: WebCliOptions,
  deps: WebCommandDeps = DEFAULT_WEB_COMMAND_DEPS,
): Promise<void> {
  let webOrigin: string;
  if (opts.daemonHost !== undefined) {
    webOrigin = normalizeDaemonOrigin(opts.daemonHost);
  } else {
    const host = opts.host ?? DEFAULT_DAEMON_HOST;
    const port = parsePort(opts.port, '--port', DEFAULT_DAEMON_PORT);
    const daemon = await deps.ensureDaemonRunning({
      host,
      port,
      logLevel: 'info',
      debugEndpoints: false,
    });
    webOrigin = daemon.origin;
    if (daemon.status === 'started') {
      deps.stdout.write(
        `Kimi daemon started in background at ${daemon.origin} (pid ${daemon.pid}).\n`,
      );
      deps.stdout.write(`Logs: ${daemon.logPath}\n`);
    }
  }

  await deps.ensureDaemonWebReady(webOrigin);
  deps.stdout.write(`Kimi web: ${webOrigin}\n`);

  if (opts.open !== false) {
    deps.openUrl(webOrigin);
  }
}

export function normalizeDaemonOrigin(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export async function ensureDaemonWebReady(origin: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${origin}/`, {
      headers: { accept: 'text/html' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = await response.text();
    if (!body.includes('<div id="app"')) {
      throw new Error('missing app root');
    }
  } catch (error) {
    const reason = error instanceof Error ? ` (${error.message})` : '';
    throw new Error(
      `Daemon at ${origin} does not serve the Kimi web UI${reason}. Stop the existing daemon and rerun \`kimi web\`, or use --daemon-host to open a compatible daemon.`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

const DEFAULT_WEB_COMMAND_DEPS: WebCommandDeps = {
  ensureDaemonRunning,
  ensureDaemonWebReady,
  openUrl: defaultOpenUrl,
  stdout: process.stdout,
  stderr: process.stderr,
};
