/**
 * Normify — normalized structure-diagram builder.
 *
 * Port of `@dsh-external/dsh-normify` v0.5.4 (DeepSeek Harness plugin) into the
 * Kimi Code monorepo, minus the DSH-specific runtime: the engine is unchanged,
 * the tool layer is host-agnostic, and adapters expose it over MCP / CLI.
 */

export { buildToolRegistry, createToolRegistry, DEFAULT_TOOL_ENV } from './tools.js';
export type { ToolEnv, ToolSpec } from './tools.js';

export {
  MCP_PROTOCOL_VERSION,
  createMcpServer,
  type McpCallResult,
  type McpServerOptions,
} from './mcp.js';

export * from './engine/types.js';
export { buildProject } from './engine/compile.js';
export { renderProject } from './engine/render.js';
export { validateProject } from './engine/validate.js';
export { listProjects, resolveProject } from './engine/store.js';
export { HELP_TOPICS } from './engine/reference.js';
