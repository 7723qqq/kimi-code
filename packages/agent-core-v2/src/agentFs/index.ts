/**
 * `agentFs` domain barrel — re-exports the agent-filesystem contract
 * (`agentFs`) and its scoped service (`agentFsService`), the wire-shaped fs
 * service (`fs`, `fsService`), the fs error codes (`errors`), and the backend
 * implementations (`localFileSystemBackend`, `sshFileSystemBackend`).
 * Importing this barrel registers the `IAgentFileSystem` / `IFsService`
 * bindings and the default local `IFileSystemBackend` into the scope registry.
 */

export * from './agentFs';
export * from './agentFsService';
export * from './errors';
export * from './fs';
export * from './fsService';
export * from './localFileSystemBackend';
export * from './sshFileSystemBackend';
