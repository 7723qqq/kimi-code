import { Disposable } from '@moonshot-ai/agent-core';
import { ILogService } from '@moonshot-ai/services';
import { pino, type Logger, type LoggerOptions } from 'pino';

export type DaemonLogger = Logger;

export type DaemonLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface CreateLoggerOptions {
  level: DaemonLogLevel;
  pretty?: boolean;
}

export function createDaemonLogger(opts: CreateLoggerOptions): DaemonLogger {
  const pretty = opts.pretty ?? process.stdout.isTTY === true;
  const base: LoggerOptions = {
    level: opts.level,
    base: { name: 'kimi-daemon' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l o',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      },
    });
  }
  return pino(base);
}

export class PinoLogger extends Disposable implements ILogService {
  readonly _serviceBrand: undefined;

  constructor(private readonly logger: DaemonLogger) {
    super();
  }

  info(obj: object | string, msg?: string): void {
    if (typeof obj === 'string') {
      this.logger.info(obj);
      return;
    }
    this.logger.info(obj, msg);
  }
  warn(obj: object | string, msg?: string): void {
    if (typeof obj === 'string') {
      this.logger.warn(obj);
      return;
    }
    this.logger.warn(obj, msg);
  }
  error(obj: object | string, msg?: string): void {
    if (typeof obj === 'string') {
      this.logger.error(obj);
      return;
    }
    this.logger.error(obj, msg);
  }
  debug(obj: object | string, msg?: string): void {
    if (typeof obj === 'string') {
      this.logger.debug(obj);
      return;
    }
    this.logger.debug(obj, msg);
  }
  child(bindings: object): ILogService {
    return new PinoLogger(this.logger.child(bindings));
  }
}
