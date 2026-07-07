/**
 * `workspaceCommand` domain barrel — re-exports the workspace-command contract
 * (`workspaceCommand`), its scoped service (`workspaceCommandService`), and the
 * workspace-local-config helpers (`workspaceLocalConfig`). Importing this
 * barrel registers the `ISessionWorkspaceCommandService` binding into the scope
 * registry.
 */

export * from './workspaceCommand';
export * from './workspaceCommandService';
export * from './workspaceLocalConfig';
