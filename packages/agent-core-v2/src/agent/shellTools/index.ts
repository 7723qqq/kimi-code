/**
 * `shellTools` domain barrel — re-exports the built-in Bash tool, the shared
 * output `ToolResultBuilder`, and the `IAgentShellToolsService` registration
 * contract + service. Importing this barrel registers the `IAgentShellToolsService`
 * binding into the scope registry.
 */

export * from './shellTools';
export * from './shellToolsService';
export * from '#/agent/shellTools/tools/bash';
export * from '#/agent/shellTools/tools/result-builder';
