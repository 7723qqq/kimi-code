/**
 * `fileTools` domain barrel — re-exports the built-in file tools (Read / Write
 * / Edit / Grep / Glob), the shared line-ending helpers, and the
 * `IAgentFileToolsService` registration contract + service. Importing this barrel
 * registers the `IAgentFileToolsService` binding into the scope registry.
 */

export * from './fileTools';
export * from './fileToolsService';
export * from '#/agent/fileTools/tools/edit';
export * from '#/agent/fileTools/tools/glob';
export * from '#/agent/fileTools/tools/grep';
export * from '#/agent/fileTools/tools/line-endings';
export * from '#/agent/fileTools/tools/read';
export * from '#/agent/fileTools/tools/write';
