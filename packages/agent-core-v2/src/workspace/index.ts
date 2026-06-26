/**
 * `workspace` domain barrel — re-exports the workspace contracts and their
 * scoped services. Importing this barrel registers every workspace binding
 * (`IWorkspaceRegistry`, `IWorkspaceFsService`, `ISessionWorkspaceService`)
 * and the domain's error codes into the scope registry.
 */

export * from './errors';
export * from './workspace';
export * from './workspaceService';
export * from './workspaceRegistry';
export * from './workspaceRegistryService';
export * from './workspaceFs';
export * from './workspaceFsService';
