export { startDaemon, DaemonLockedError } from './start';
export type { DaemonStartOptions, RunningDaemon } from './start';
export { okEnvelope, errEnvelope } from './envelope';
export type { Envelope } from './envelope';
export { createDaemonLogger } from './services/pinoLoggerService';
export type {
  CreateLoggerOptions,
  DaemonLogger,
  DaemonLogLevel,
} from './services/pinoLoggerService';
export { acquireLock, DEFAULT_LOCK_PATH, DEFAULT_LOCK_DIR } from './lock';
export type { AcquireLockOptions, AcquireLockResult, LockContents } from './lock';

export { IRestGateway } from '#/services/gateway';
export { IConnectionRegistry } from '#/services/gateway';
export { ISessionClientsService } from '#/services/gateway';
export { IWSGateway } from '#/services/gateway';
export { IWSBroadcastService } from '#/services/gateway';

export {
  IEventService,
  IApprovalService,
  IQuestionService,
  ICoreProcessService,
  ILogService,
  IModelCatalogService,
  ISessionService,
  SessionNotFoundError,
} from '@moonshot-ai/services';
