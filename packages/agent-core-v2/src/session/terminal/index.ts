/**
 * `terminal` domain barrel — re-exports the OS terminal contract and the
 * Session-scoped terminal facade.
 */

export * from '#/os/interface/terminal';
export * from '#/os/interface/terminalErrors';
export * from '#/os/backends/node-local/hostTerminalService';
export * from './terminalService';
