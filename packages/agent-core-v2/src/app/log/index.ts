/**
 * `log` domain barrel — re-exports the logging contract and the App-scope
 * log services. Importing this barrel registers the `ILogService` and
 * console `ILogWriterService` bindings into the scope registry.
 */

export * from './log';
export * from './logConfig';
export * from './logService';
export * from './formatter';
