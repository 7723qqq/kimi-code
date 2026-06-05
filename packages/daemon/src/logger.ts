import { pino, type Logger, type LoggerOptions } from 'pino';

export type DaemonLogger = Logger;

export type DaemonLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface CreateLoggerOptions {
  level: DaemonLogLevel;
  /**
   * Force pretty printing on/off. Defaults to TTY detection on stdout.
   * Useful for tests that want deterministic JSON output.
   */
  pretty?: boolean;
}

export function createDaemonLogger(opts: CreateLoggerOptions): DaemonLogger {
  const pretty = opts.pretty ?? process.stdout.isTTY === true;
  const base: LoggerOptions = {
    level: opts.level,
    base: { name: 'kimi-daemon' },
  };
  if (pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      },
    });
  }
  return pino(base);
}
