import type { Message as ProtocolMessage, SessionStatusResponse } from '@moonshot-ai/protocol';

import { toContextMessage } from '../mappers';
import type { CoreApiHandlerMap } from '../types';

interface SessionScopedPayload {
  readonly sessionId: string;
  readonly agentId?: string;
}

export const contextHandlers: CoreApiHandlerMap = {
  beginCompaction: async (payload, ctx) => {
    const { sessionId } = payload as SessionScopedPayload & { instruction?: string };
    const instruction = (payload as { instruction?: string }).instruction;
    await ctx.http.post(`/sessions/${sessionId}:compact`, { instruction });
  },

  undoHistory: async (payload, ctx) => {
    const { sessionId } = payload as SessionScopedPayload & { count: number };
    const count = (payload as { count: number }).count;
    await ctx.http.post(`/sessions/${sessionId}:undo`, { count });
  },

  getContext: async (payload, ctx) => {
    const { sessionId } = payload as SessionScopedPayload;
    const [page, status] = await Promise.all([
      ctx.http.get<{ items: ProtocolMessage[]; has_more: boolean }>(`/sessions/${sessionId}/messages`),
      ctx.http.get<SessionStatusResponse>(`/sessions/${sessionId}/status`),
    ]);
    return {
      history: page.items.map(toContextMessage),
      tokenCount: status.context_tokens,
    };
  },

  getUsage: async (payload, ctx) => {
    const { sessionId } = payload as SessionScopedPayload;
    const session = await ctx.http.get<{ usage: unknown }>(`/sessions/${sessionId}`);
    return session.usage;
  },

  // Degraded: KAP exposes no plan content endpoint; plan_mode boolean comes from getStatus.
  getPlan: async () => null,

  clearPlan: async (payload, ctx) => {
    const { sessionId } = payload as SessionScopedPayload;
    await ctx.http.post(`/sessions/${sessionId}/profile`, { agent_config: { plan_mode: false } });
  },
};
