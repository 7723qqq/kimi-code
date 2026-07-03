/**
 * `agentFs` domain barrel — re-exports the agent-filesystem contract
 * (now in `os/interface`) and its node-local backend (now in
 * `os/backends/node-local`), plus the session-level facade files that
 * stay here.
 */

export * from '#/os/interface/fileSystem';
export * from '#/os/backends/node-local/agentFsService';
export * from './errors';
export * from './fs';
export * from './fsService';
export * from './gitContext';
export * from './rgLocator';
export * from './runRg';
