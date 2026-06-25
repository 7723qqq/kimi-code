/**
 * `log` domain (L1) — `ILogService` implementation and built-in writers.
 *
 * Filters entries by the configured `LogLevel` and writes them to the bound
 * `ILogWriterService`; provides the console and in-memory `ILogWriterService` implementations.
 * Bound at Core scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  type ILogger,
  type LogContext,
  type LogEntry,
  type LogEntryError,
  type LogLevel,
  type LogPayload,
  ILogService,
  ILogWriterService,
  levelEnabled,
} from './log';

function extractError(payload: LogPayload): LogEntryError | undefined {
  if (payload instanceof Error) {
    return { message: payload.message, stack: payload.stack };
  }
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    (payload as { error: unknown }).error instanceof Error
  ) {
    const err = (payload as { error: Error }).error;
    return { message: err.message, stack: err.stack };
  }
  return undefined;
}

function extractContext(payload: LogPayload): LogContext | undefined {
  if (typeof payload === 'object' && payload !== null && !(payload instanceof Error)) {
    return { ...(payload as LogContext) };
  }
  if (payload !== undefined && !(payload instanceof Error)) {
    return { reason: typeof payload === 'string' ? payload : JSON.stringify(payload) };
  }
  return undefined;
}

export class MemoryLogWriterService implements ILogWriterService {
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

export class ConsoleLogWriterService implements ILogWriterService {
  write(entry: LogEntry): void {
    const line = entry.ctx !== undefined ? `${entry.msg} ${JSON.stringify(entry.ctx)}` : entry.msg;
    switch (entry.level) {
      case 'error':
        // eslint-disable-next-line no-console
        console.error(line);
        break;
      case 'warn':
        // eslint-disable-next-line no-console
        console.warn(line);
        break;
      case 'debug':
        // eslint-disable-next-line no-console
        console.debug(line);
        break;
      default:
        // eslint-disable-next-line no-console
        console.log(line);
    }
  }
}

export class LogService implements ILogService {
  declare readonly _serviceBrand: undefined;
  private _level: LogLevel;

  constructor(
    @ILogWriterService protected readonly writer: ILogWriterService,
    private readonly bound: LogContext = {},
    level: LogLevel = 'info',
  ) {
    this._level = level;
  }

  get level(): LogLevel {
    return this._level;
  }

  setLevel(level: LogLevel): void {
    this._level = level;
  }

  flush(): Promise<void> {
    return this.writer.flush?.() ?? Promise.resolve();
  }

  error(message: string, payload?: LogPayload): void {
    this.emit('error', message, payload);
  }
  warn(message: string, payload?: LogPayload): void {
    this.emit('warn', message, payload);
  }
  info(message: string, payload?: LogPayload): void {
    this.emit('info', message, payload);
  }
  debug(message: string, payload?: LogPayload): void {
    this.emit('debug', message, payload);
  }

  child(ctx: LogContext): ILogger {
    return new LogService(this.writer, { ...this.bound, ...ctx }, this._level);
  }

  private emit(
    level: Exclude<LogLevel, 'off'>,
    message: string,
    payload?: LogPayload,
  ): void {
    if (!levelEnabled(level, this._level)) return;
    const payloadCtx = extractContext(payload);
    const error = extractError(payload);
    const ctx =
      payloadCtx !== undefined || Object.keys(this.bound).length > 0
        ? { ...payloadCtx, ...this.bound }
        : undefined;
    const entry: LogEntry = {
      t: Date.now(),
      level,
      msg: message,
      ...(ctx !== undefined ? { ctx } : {}),
      ...(error !== undefined ? { error } : {}),
    };
    this.writer.write(entry);
  }
}

registerScopedService(
  LifecycleScope.Core,
  ILogWriterService,
  ConsoleLogWriterService,
  InstantiationType.Eager,
  'log',
);
registerScopedService(
  LifecycleScope.Core,
  ILogService,
  LogService,
  InstantiationType.Eager,
  'log',
);
