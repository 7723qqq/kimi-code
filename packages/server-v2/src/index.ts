/**
 * `@moonshot-ai/server-v2` public surface — the Kimi Code server backed by the
 * DI × Scope agent engine (`@moonshot-ai/agent-core-v2`).
 */

export { startServer } from './start';
export type { ServerStartOptions, RunningServer } from './start';
export { okEnvelope, errEnvelope } from './envelope';
export type { Envelope } from './envelope';
export { createServerLogger } from './services/pinoLoggerService';
export type {
  CreateLoggerOptions,
  ServerLogger,
  ServerLogLevel,
} from './services/pinoLoggerService';
