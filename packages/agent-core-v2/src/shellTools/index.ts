/**
 * `shellTools` domain barrel — re-exports the built-in Bash tool, the shared
 * output `ToolResultBuilder`, and the `IShellToolsService` registration
 * contract + service. Importing this barrel registers the `IShellToolsService`
 * binding into the scope registry.
 */

export * from './shellTools';
export * from './shellToolsService';
export * from './tools/bash';
export * from './tools/result-builder';
