/**
 * Tool + MCP adapter (Chain 7 / P1.7, W9.1).
 *
 * Translates agent-core's `ToolInfo` + `McpServerInfo` (camelCase, agent-core
 * literal sets) into SCHEMAS §8 `ToolDescriptor` + `McpServer` (snake_case,
 * spec-literal sets). Reference: `packages/protocol/src/tool.ts` header.
 *
 * The adapter handles three mismatch areas:
 *
 *  1. **Tool source literal**: agent-core uses `'user'`; SCHEMAS §8 uses
 *     `'skill'`. We map `'user' → 'skill'` so the wire schema doesn't have to
 *     accept the agent-core variant. `'builtin'` and `'mcp'` pass through.
 *
 *  2. **input_schema**: agent-core's `ToolInfo` does not surface a per-tool
 *     JSON schema today. We emit `null` (per SCHEMAS "未知字段宽松" the
 *     wire schema accepts `unknown`, and `null` is the most honest signal).
 *
 *  3. **mcp_server_id**: agent-core qualifies MCP tools as
 *     `mcp:<server>:<tool>`. When the source is `'mcp'`, we parse the second
 *     `:` segment as the server id. If the name doesn't match the expected
 *     prefix shape (e.g. agent-core ever changes the convention) we omit
 *     the field rather than emitting a misleading value.
 *
 *  4. **MCP status mapping** (`McpServerInfo.status` → `McpServer.status`):
 *       agent-core 'pending'    → wire 'connecting'
 *       agent-core 'connected'  → wire 'connected'
 *       agent-core 'failed'     → wire 'error'
 *       agent-core 'disabled'   → wire 'disconnected'
 *       agent-core 'needs-auth' → wire 'error'   (last_error carries the hint)
 *
 *  5. **MCP id**: agent-core's `McpServerInfo` has only `name`. We adopt
 *     name-as-id at the wire boundary. Both are 1:1 within a daemon process.
 */

import type { McpServerInfo } from '@moonshot-ai/agent-core';
import type {
  McpServer,
  McpServerStatus,
  McpServerTransport,
  ToolDescriptor,
  ToolSource,
} from '@moonshot-ai/protocol';

/**
 * In-process minimal shape we accept for tool conversion. Mirrors
 * `@moonshot-ai/agent-core` `ToolInfo` without taking a runtime dependency on
 * its exact shape (the adapter is the boundary).
 */
export interface AgentCoreToolInfoLike {
  readonly name: string;
  readonly description: string;
  readonly source: 'builtin' | 'user' | 'mcp';
  /** agent-core may add fields like `active`; we ignore them. */
  readonly active?: boolean;
}

function mapToolSource(s: AgentCoreToolInfoLike['source']): ToolSource {
  switch (s) {
    case 'builtin':
      return 'builtin';
    case 'user':
      return 'skill';
    case 'mcp':
      return 'mcp';
  }
}

/**
 * Parse the server id segment from an MCP tool name. Convention:
 * `mcp:<server>:<tool>` (kosong's `mcpRegistrar.qualifiedName`). Returns
 * `undefined` when the name does not match — caller omits `mcp_server_id`.
 */
function parseMcpServerIdFromToolName(name: string): string | undefined {
  if (!name.startsWith('mcp:')) return undefined;
  const rest = name.slice('mcp:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return undefined;
  return rest.slice(0, sep);
}

export function toProtocolTool(info: AgentCoreToolInfoLike): ToolDescriptor {
  const source = mapToolSource(info.source);
  const base: ToolDescriptor = {
    name: info.name,
    description: info.description,
    // agent-core's ToolInfo lacks a JSON schema today; emit null so the
    // wire schema is honest about "unknown".
    input_schema: null,
    source,
  };
  if (source === 'mcp') {
    const serverId = parseMcpServerIdFromToolName(info.name);
    if (serverId !== undefined) {
      return { ...base, mcp_server_id: serverId };
    }
  }
  return base;
}

// --- MCP server -------------------------------------------------------------

function mapMcpStatus(s: McpServerInfo['status']): McpServerStatus {
  switch (s) {
    case 'connected':
      return 'connected';
    case 'pending':
      return 'connecting';
    case 'failed':
      return 'error';
    case 'disabled':
      return 'disconnected';
    case 'needs-auth':
      // Closest wire literal; `last_error` carries the explanatory message.
      return 'error';
  }
}

function mapMcpTransport(t: McpServerInfo['transport']): McpServerTransport {
  // SCHEMAS §8 transport is a superset (adds 'sse'); the two agent-core
  // literals pass through unchanged.
  switch (t) {
    case 'stdio':
      return 'stdio';
    case 'http':
      return 'http';
  }
}

export function toProtocolMcpServer(info: McpServerInfo): McpServer {
  const status = mapMcpStatus(info.status);
  const base: McpServer = {
    // name-as-id: agent-core doesn't surface a separate id; the daemon's
    // REST path uses {mcp_server_id} which we interpret as the name.
    id: info.name,
    name: info.name,
    transport: mapMcpTransport(info.transport),
    status,
    tool_count: info.toolCount,
  };
  // Surface the upstream error message when present. We expose it on every
  // non-healthy status (not just 'error') because 'needs-auth' arrives with
  // `error` carrying the auth-hint URL.
  if (info.error !== undefined && info.error.length > 0) {
    return { ...base, last_error: info.error };
  }
  return base;
}
