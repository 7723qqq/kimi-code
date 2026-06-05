/**
 * `IMcpService` — daemon-facing MCP server surface (Chain 7 / P1.7, W9.1).
 *
 * Wraps `IHarnessBridge.rpc.{listMcpServers, reconnectMcpServer}` and adapts
 * the agent-core `McpServerInfo` shape into SCHEMAS §8 `McpServer`. The
 * adapter lives at `packages/services/src/adapter/tool-adapter.ts`.
 *
 * **CoreAPI surface used**:
 *   - `bridge.rpc.listMcpServers({}) => readonly McpServerInfo[]`
 *     (packages/agent-core/src/rpc/core-api.ts:344).
 *   - `bridge.rpc.reconnectMcpServer({name})` (line 346).
 *
 * **Server identity**: REST.md §3.8 uses `{mcp_server_id}` in the path;
 * agent-core surfaces only `name`. We treat name-as-id at the wire boundary
 * (stable within a daemon process lifetime).
 *
 * **Error model**:
 *   - `MCP_SERVER_NOT_FOUND` (40408) is raised by the impl via
 *     `McpServerNotFoundError`. The route maps it to envelope code 40408.
 *
 * **Side effects of restart** (REST.md §3.8 line 442): daemon should broadcast
 * `event.mcp.disconnected` → `event.mcp.connecting` → `event.mcp.connected|error`.
 * That observability arrives once the bridge gets MCP lifecycle observers
 * (out of W9 scope; W12+).
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for the
 * `createDecorator` value used to mint the service identifier.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { McpServer } from '@moonshot-ai/protocol';

export interface IMcpService {
  /** Return all MCP servers known to the in-process KimiCore. */
  list(): Promise<readonly McpServer[]>;

  /**
   * Trigger an MCP server reconnect. Returns `{ restarting: true }` on a
   * successful enqueue. Throws `McpServerNotFoundError` (→ 40408) when the
   * server id is not registered.
   */
  restart(serverId: string): Promise<{ restarting: true }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IMcpService = createDecorator<IMcpService>('IMcpService');

/**
 * Sentinel — daemon's route layer catches this and maps to envelope `code:
 * 40408 mcp.server_not_found`. Other thrown errors fall through to W4's
 * `installErrorHandler` (→ 50001).
 */
export class McpServerNotFoundError extends Error {
  readonly serverId: string;
  constructor(serverId: string) {
    super(`mcp server ${serverId} does not exist`);
    this.name = 'McpServerNotFoundError';
    this.serverId = serverId;
  }
}
