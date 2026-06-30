/**
 * `fileTools` domain barrel — re-exports the built-in file tools (Read / Write
 * / Edit / Grep / Glob), the shared line-ending helpers, and the
 * `IFileToolsService` registration contract + service. Importing this barrel
 * registers the `IFileToolsService` binding into the scope registry.
 */

export * from './fileTools';
export * from './fileToolsService';
export * from './tools/edit';
export * from './tools/glob';
export * from './tools/grep';
export * from './tools/line-endings';
export * from './tools/read';
export * from './tools/write';
