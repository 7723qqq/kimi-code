/**
 * `ILogger` DI surface (W4.4 / P0.14).
 *
 * Thin interface over the pino logger so consumer services don't take a
 * direct dependency on the `pino` package. The daemon registers a
 * `PinoLogger` adapter that delegates to the `DaemonLogger` (pino) instance
 * Fastify shares with us at boot.
 *
 * Registered FIRST in the DI container (= constructed first when consumers
 * dispatch `accessor.get(ILogger)`) so it disposes LAST in the
 * reverse-construction-order teardown chain (W3 handoff §Gotchas). Other
 * services log on their own `dispose()`; if the logger went first they'd NPE.
 */

import { Disposable, createDecorator } from '@moonshot-ai/agent-core';

import type { DaemonLogger } from '../logger.js';

export interface ILogger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;
  /** Pino-style child logger that inherits parent bindings. */
  child(bindings: object): ILogger;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ILogger = createDecorator<ILogger>('ILogger');

/**
 * Adapter that satisfies `ILogger` by delegating to a `DaemonLogger` (pino).
 * No-op `dispose()`: pino's lifetime is managed by Fastify / the host process,
 * NOT by the DI container. Disposing here would close stdout writer streams
 * that other components still need during teardown.
 */
export class PinoLogger extends Disposable implements ILogger {
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
  child(bindings: object): ILogger {
    return new PinoLogger(this.logger.child(bindings));
  }
}
