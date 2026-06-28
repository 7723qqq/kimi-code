/**
 * Pino logger factory for the server process.
 *
 * Produces the `ServerLogger` handed to Fastify via `loggerInstance`. Unlike the
 * v1 server, server-v2 does not adapt this logger into the engine's
 * `ILogService` — `agent-core-v2` registers its own `ILogService` at Core scope,
 * so the HTTP-layer logger stays a plain pino instance.
 */

import { pino, type Logger, type LoggerOptions } from 'pino';
import prettyStream from 'pino-pretty';

export type ServerLogger = Logger;

export type ServerLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface CreateLoggerOptions {
  level: ServerLogLevel;
  pretty?: boolean;
}

export function createServerLogger(opts: CreateLoggerOptions): ServerLogger {
  const pretty = opts.pretty ?? process.stdout.isTTY === true;
  const base: LoggerOptions = {
    level: opts.level,
    base: { name: 'kimi-server-v2' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (pretty) {
    return pino(
      base,
      prettyStream({
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l o',
        ignore: 'pid,hostname',
        singleLine: false,
        destination: process.stdout,
      }),
    );
  }
  return pino(base);
}
