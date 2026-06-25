/**
 * `log` domain (L1) — `ISessionLogService` implementation.
 *
 * Per-session logger: binds `sessionId` to every entry and writes to the
 * Session-scoped `ILogWriterService` (a rotating file writer owned by the Session scope).
 * Bound at Session scope (Delayed) so sessions that never emit logs allocate
 * nothing.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { ILogWriterService, ISessionLogOptions, ISessionLogService } from './log';
import { ILogOptions } from './logConfig';
import { LogService } from './logService';

export class SessionLogService extends LogService implements ISessionLogService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ILogWriterService writer: ILogWriterService,
    @ILogOptions options: ILogOptions,
    @ISessionLogOptions session: ISessionLogOptions,
  ) {
    super(writer, { sessionId: session.sessionId }, options.level);
  }

  close(): Promise<void> {
    return this.writer.close?.() ?? Promise.resolve();
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionLogService,
  SessionLogService,
  InstantiationType.Delayed,
  'log',
);
