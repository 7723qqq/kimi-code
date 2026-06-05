export { startDaemon, DaemonLockedError } from './start.js';
export type { DaemonStartOptions, RunningDaemon } from './start.js';
export { okEnvelope, errEnvelope } from './envelope.js';
export type { Envelope } from './envelope.js';
export { createDaemonLogger } from './logger.js';
export type { CreateLoggerOptions, DaemonLogger, DaemonLogLevel } from './logger.js';
export { acquireLock, DEFAULT_LOCK_PATH, DEFAULT_LOCK_DIR } from './lock.js';
export type { AcquireLockOptions, AcquireLockResult, LockContents } from './lock.js';

// DI service decorators — re-exported so consumers / tests can `a.get(ILogger)` etc.
// The concrete impls (PinoLogger, FastifyRestGateway, DaemonEventBus, broker stubs,
// ConnectionRegistry, SessionClientsService, WSGateway) stay internal — daemon
// owns its wiring choices; external consumers see only the interfaces.
export { ILogger } from './services/logger.js';
export { IRestGateway } from './services/rest-gateway.js';
export { IConnectionRegistry } from './services/connection-registry.js';
export { ISessionClientsService } from './services/session-clients.js';
export { IWSGateway } from './services/ws-gateway.js';
// Re-export the broker decorators + HarnessBridge handle from `@moonshot-ai/services`
// so daemon consumers don't have to take a direct dep on the services package
// just to reach into the container.
export {
  IEventBus,
  IApprovalBroker,
  IQuestionBroker,
  IHarnessBridge,
  ISessionService,
  SessionNotFoundError,
} from '@moonshot-ai/services';
