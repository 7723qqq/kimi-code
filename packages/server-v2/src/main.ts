/**
 * CLI entry for `pnpm dev:server` — boots server-v2 (the `@moonshot-ai/agent-core-v2`
 * DI engine) in the foreground and blocks until SIGINT/SIGTERM.
 *
 * Flags: `--port <n>` (default 58627), `--host <h>` (default 127.0.0.1),
 * `--log-level <level>` (default info), `--dangerous-bypass-auth` (disable
 * bearer-token auth on every route — trusted networks only).
 */

import type { ServerLogLevel } from './services/pinoLoggerService';
import { type RunningServer, startServer } from './start';

interface CliOptions {
  readonly host?: string;
  readonly port?: number;
  readonly logLevel?: ServerLogLevel;
  readonly disableAuth?: boolean;
}

const LOG_LEVELS: readonly ServerLogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

function parseArgs(argv: readonly string[]): CliOptions {
  let host: string | undefined;
  let port: number | undefined;
  let logLevel: ServerLogLevel | undefined;
  let disableAuth: boolean | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === '--host' || arg === '-h') && next !== undefined) {
      host = next;
      i++;
    } else if ((arg === '--port' || arg === '-p') && next !== undefined) {
      const n = Number(next);
      if (Number.isInteger(n) && n >= 0 && n <= 65535) port = n;
      i++;
    } else if (
      arg === '--log-level' &&
      next !== undefined &&
      (LOG_LEVELS as readonly string[]).includes(next)
    ) {
      logLevel = next as ServerLogLevel;
      i++;
    } else if (arg === '--dangerous-bypass-auth') {
      disableAuth = true;
    }
  }

  return { host, port, logLevel, disableAuth };
}

async function main(): Promise<never> {
  const opts = parseArgs(process.argv.slice(2));
  const server: RunningServer = await startServer({
    host: opts.host,
    port: opts.port,
    logLevel: opts.logLevel ?? 'info',
    disableAuth: opts.disableAuth,
  });

  const origin = `http://${server.host}:${server.port}`;
  process.stdout.write(`Kimi server (v2) ready at ${origin}\n`);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
    } catch {
      // best-effort
    }
    process.exit(0);
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });

  return new Promise<never>(() => {
    // Keeps the event loop alive; the process ends via shutdown()/process.exit.
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
