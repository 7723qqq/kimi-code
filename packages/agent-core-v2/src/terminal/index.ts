/**
 * `terminal` domain barrel — re-exports the terminal contract (`terminal`),
 * its scoped service (`terminalService`), the default backend stub
 * (`terminalBackend`), and the domain error codes (`errors`). Importing this
 * barrel registers the `ISessionTerminalService` and default `ISessionTerminalBackend`
 * bindings into the scope registry.
 */

export * from './terminal';
export * from './errors';
export * from './terminalService';
export * from './terminalBackend';
