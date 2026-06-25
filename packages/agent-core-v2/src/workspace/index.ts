/**
 * `workspace` domain barrel — re-exports the workspace contract (`workspace`)
 * and its scoped service (`workspaceService`). Importing this barrel registers
 * the `IWorkspaceService` binding into the scope registry.
 */

export * from './workspace';
export * from './workspaceService';
