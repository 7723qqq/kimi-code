/**
 * Localized legacy error primitives — the SDK's own copies of the v1 core's
 * error surface (`KimiError` class, the code registry, and the wire
 * serializer). The v1 `agent-core` package is being removed; these definitions
 * keep the SDK's public error contract (`KimiError` / `ErrorCodes` /
 * `KimiErrorPayload`) intact without importing it. New code should prefer the
 * v2 primitives (`Error2` / `isError2` from `@moonshot-ai/agent-core-v2`);
 * these legacy shapes are kept for the SDK's public API and the remaining
 * v1-client path until that client is removed.
 */
export {
  ErrorCodes,
  KIMI_ERROR_INFO,
  resolveErrorTitle,
  type KimiErrorCode,
  type KimiErrorInfo,
} from './error-codes';
export { KimiError, type KimiErrorOptions } from './kimi-error';
export {
  fromKimiErrorPayload,
  isKimiError,
  makeErrorPayload,
  toKimiErrorPayload,
  type KimiErrorPayload,
} from './serialize';
export { noopTelemetryClient, withTelemetryContext, withTelemetryProperties } from './telemetry';
export type {
  TelemetryClient,
  TelemetryContextPatch,
  TelemetryProperties,
} from './telemetry';
export {
  ensureConfigFile,
  HookDefSchema,
  limitAgentReplayByTurns,
  type HookDefConfig,
  type HookEventType,
} from './config-helpers';
export { effectiveModelAlias, effectiveModelAliases } from './model-alias';
export {
  __resetRootLoggerForTest,
  flushDiagnosticLogs,
  flushDiagnosticLogsSync,
  formatEntry,
  getRootLogger,
  levelEnabled,
  log,
  LOG_LEVEL_RANK,
  redact,
  redactCtx,
  RotatingFileSink,
  type FormattedEntry,
  type FormatOptions,
  type LogContext,
  type LogEntry,
  type LoggingConfig,
  type LogLevel,
  type Logger,
  type LogPayload,
  type RootLogger,
  type Sink,
} from './logging';
