import type { CoreApiHandlerMap } from '../types';

interface SessionScopedPayload {
  readonly sessionId: string;
  readonly taskId?: string;
  readonly name?: string;
  readonly tail?: number;
  readonly activeOnly?: boolean;
  readonly limit?: number;
  readonly reason?: string;
}

export const serviceHandlers: CoreApiHandlerMap = {
  // Background tasks
  getBackground: async (payload, ctx) => {
    const { sessionId, activeOnly, limit } = payload as SessionScopedPayload;
    const result = await ctx.http.get<{ items: unknown[] }>(`/sessions/${sessionId}/tasks`, {
      ...(activeOnly !== undefined ? { status: activeOnly ? 'running' : undefined } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return result.items;
  },

  getBackgroundOutput: async (payload, ctx) => {
    const { sessionId, taskId } = payload as SessionScopedPayload;
    const result = await ctx.http.get<{ output_preview?: string; output_bytes?: number }>(
      `/sessions/${sessionId}/tasks/${taskId}`,
      { with_output: 'true' },
    );
    return result.output_preview ?? '';
  },

  stopBackground: async (payload, ctx) => {
    const { sessionId, taskId } = payload as SessionScopedPayload;
    await ctx.http.post(`/sessions/${sessionId}/tasks/${taskId}:cancel`, {});
  },

  // Skills
  listSkills: async (payload, ctx) => {
    const { sessionId } = payload as SessionScopedPayload;
    const result = await ctx.http.get<{ skills: unknown[] }>(`/sessions/${sessionId}/skills`);
    return result.skills;
  },

  // MCP
  listMcpServers: async (_payload, ctx) => {
    const result = await ctx.http.get<{ servers: unknown[] }>('/mcp/servers');
    return result.servers;
  },

  reconnectMcpServer: async (payload, ctx) => {
    const { name } = payload as SessionScopedPayload;
    await ctx.http.post(`/mcp/servers/${encodeURIComponent(name ?? '')}:restart`, {});
  },
};
