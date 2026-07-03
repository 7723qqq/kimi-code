/**
 * `telemetry` domain barrel — re-exports the `telemetry` contract, its scoped
 * service (`telemetryService`), the agent-scoped ambient telemetry context
 * (`agentTelemetryContextService`), and the bundled appenders (`ConsoleAppender`,
 * `CloudAppender`). Importing this barrel registers the `ITelemetryService` and
 * `IAgentTelemetryContextService` bindings into the scope registry.
 */

export * from './telemetry';
export * from './telemetryService';
export * from './agentTelemetryContext';
export * from './agentTelemetryContextService';
export * from './consoleAppender';
export * from './cloudAppender';
