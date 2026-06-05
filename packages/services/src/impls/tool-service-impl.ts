/**
 * `ToolServiceImpl` — adapter between protocol-shaped REST surface and
 * agent-core's `getTools` CoreAPI (Chain 7 / P1.7, W9.1).
 *
 * Wraps `IHarnessBridge.rpc.getTools({sessionId, agentId})` and maps
 * `ToolInfo[]` → `ToolDescriptor[]` via `tool-adapter.toProtocolTool`.
 *
 * **CoreAPI surface — `getTools` is AGENT-scoped**: agent-core's `getTools`
 * payload requires `{sessionId, agentId}` (CoreAPI extends
 * `WithSessionId<WithAgentId<AgentAPI>>`). The wire surface
 * `GET /v1/tools?session_id=<id>` is "session-effective"; we forward to the
 * `'main'` agent. When NO `session_id` is supplied (REST.md §3.8 line 430:
 * "不传则返回全局可用列表"), we attempt to use any known session to enumerate
 * the global tool registry; when no sessions exist we return an empty list.
 * agent-core's `ToolInfo` set is process-global (the registrar holds builtins
 * + skills + MCP tools) so any active session surfaces the same set; the
 * `active` flag (which we drop) is the only per-agent variation.
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for the
 * `Disposable` base type.
 */

import { Disposable } from '@moonshot-ai/agent-core';
import type { ToolDescriptor } from '@moonshot-ai/protocol';

import { IHarnessBridge } from '../bridge/harness-bridge';
import { IToolService } from '../interfaces/tool-service';
import { toProtocolTool, type AgentCoreToolInfoLike } from '../adapter/tool-adapter';

/** Matches the convention used elsewhere in services (message-service uses 'main'). */
const MAIN_AGENT_ID = 'main';

export class ToolServiceImpl extends Disposable implements IToolService {
  constructor(@IHarnessBridge private readonly bridge: IHarnessBridge) {
    super();
  }

  async list(sessionId?: string): Promise<readonly ToolDescriptor[]> {
    const resolvedSid = sessionId ?? (await this._anyKnownSessionId());
    if (resolvedSid === undefined) return [];
    let raw: readonly unknown[];
    try {
      raw = await this.bridge.rpc.getTools({
        sessionId: resolvedSid,
        agentId: MAIN_AGENT_ID,
      });
    } catch {
      // Session not loaded into the active session map; return empty rather
      // than surface a 500 — the global-list semantics is "best effort".
      return [];
    }
    return raw.map((t) => toProtocolTool(t as AgentCoreToolInfoLike));
  }

  /**
   * Find a usable session id when caller hasn't supplied one. Returns the
   * most recently created session id, or `undefined` when no sessions exist.
   */
  private async _anyKnownSessionId(): Promise<string | undefined> {
    const all = await this.bridge.rpc.listSessions({});
    if (all.length === 0) return undefined;
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
    return sorted[0]?.id;
  }
}

void IToolService;
