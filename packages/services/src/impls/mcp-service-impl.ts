/**
 * `McpServiceImpl` — adapter between protocol-shaped REST surface and
 * agent-core's `listMcpServers` + `reconnectMcpServer` (Chain 7 / P1.7, W9.1).
 *
 * Wraps `IHarnessBridge.rpc.{listMcpServers, reconnectMcpServer}` and adapts
 * the `McpServerInfo` shape into SCHEMAS §8 `McpServer` via
 * `tool-adapter.toProtocolMcpServer`.
 *
 * **agent-core API note**: `listMcpServers` is exposed on the SessionAPI
 * (per-session). Per REST.md §3.8 the wire endpoint `/api/v1/mcp/servers` is
 * GLOBAL (not session-scoped). We pass the agent-core implicit session id
 * `'__global__'` via the bridge — but agent-core's `listMcpServers` actually
 * reads from the in-process MCP registrar which is process-global today, so
 * the implementation routes through whichever session id the bridge expects.
 *
 * Since `bridge.rpc.listMcpServers` is auto-wrapped with `sessionId` injection
 * (the `SessionAPI` proxy at `core-impl.ts` injects the current `sessionId`
 * field), we cannot directly call it without a session context. The bridge's
 * `HarnessRPC` exposes the method requiring `sessionId` in the payload. For
 * the global REST surface we accept ANY known session id; the daemon route
 * can pass a probe (e.g. first session from `listSessions`) or — when no
 * sessions exist — return an empty list. We implement the latter to keep the
 * daemon's `/api/v1/mcp/servers` 200-OK before any session is created.
 *
 * **Reconnect**: `bridge.rpc.reconnectMcpServer({name, sessionId})` likewise
 * needs a session anchor. We forward the route-supplied `sessionId` (the
 * `:restart` REST endpoint is global today, so the impl picks the first
 * known session). Missing/unknown server name → `McpServerNotFoundError`.
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for the
 * `Disposable` base type.
 */

import { Disposable } from '@moonshot-ai/agent-core';
import type { McpServer } from '@moonshot-ai/protocol';

import { IHarnessBridge } from '../bridge/harness-bridge';
import { IMcpService, McpServerNotFoundError } from '../interfaces/mcp-service';
import { toProtocolMcpServer } from '../adapter/tool-adapter';

export class McpServiceImpl extends Disposable implements IMcpService {
  constructor(@IHarnessBridge private readonly bridge: IHarnessBridge) {
    super();
  }

  async list(): Promise<readonly McpServer[]> {
    // `listMcpServers` is on the SessionAPI surface; we need a session id to
    // dispatch. Pick the most recently created one. If no sessions exist,
    // return an empty list (the MCP registrar may have started up but the
    // RPC plumbing isn't reachable until a session is open).
    const sessionId = await this._anyKnownSessionId();
    if (sessionId === undefined) return [];
    const raw = await this.bridge.rpc.listMcpServers({ sessionId });
    return raw.map(toProtocolMcpServer);
  }

  async restart(serverId: string): Promise<{ restarting: true }> {
    const sessionId = await this._anyKnownSessionId();
    if (sessionId === undefined) {
      // No session => no MCP registrar reachable => server can't be reached.
      throw new McpServerNotFoundError(serverId);
    }
    // Existence check: the wire id is the agent-core `name`. The reconnect
    // call will reject for unknown names; we pre-check so the route can
    // emit a deterministic 40408 envelope without depending on agent-core
    // error message shape.
    const known = await this.bridge.rpc.listMcpServers({ sessionId });
    if (!known.some((s) => s.name === serverId)) {
      throw new McpServerNotFoundError(serverId);
    }
    await this.bridge.rpc.reconnectMcpServer({ sessionId, name: serverId });
    return { restarting: true };
  }

  /**
   * Find a usable session id for dispatching SessionAPI calls. Returns the
   * most recently created session id, or `undefined` when no sessions exist.
   */
  private async _anyKnownSessionId(): Promise<string | undefined> {
    const all = await this.bridge.rpc.listSessions({});
    if (all.length === 0) return undefined;
    // Sort by createdAt desc — newest sessions are the most likely to have
    // an active MCP RPC binding.
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
    return sorted[0]?.id;
  }
}

void IMcpService;
