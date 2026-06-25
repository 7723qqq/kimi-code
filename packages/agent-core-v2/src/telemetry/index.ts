/**
 * `telemetry` domain barrel — re-exports the `telemetry` contract, its scoped
 * service (`telemetryService`), and the bundled sinks (`ConsoleSink`,
 * `CloudSink`). Importing this barrel registers the `ITelemetryService`
 * binding into the scope registry.
 */

export * from './telemetry';
export * from './telemetryService';
export * from './consoleSink';
export * from './cloudSink';
