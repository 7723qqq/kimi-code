import type { CoreAPI } from '@moonshot-ai/agent-core';
import type { MetaResponse } from '@moonshot-ai/protocol';

import type { CoreApiHandlerMap, CoreProxyContext } from '../types';

type CoreInfo = Awaited<ReturnType<CoreAPI['getCoreInfo']>>;

export const metaHandlers: CoreApiHandlerMap = {
  getCoreInfo: async (_payload, ctx: CoreProxyContext) => {
    const meta = await ctx.http.get<MetaResponse>('/meta');
    const info: CoreInfo = {
      version: meta.server_version,
    };
    return info;
  },

  getKimiConfig: async (_payload, ctx: CoreProxyContext) => {
    return ctx.http.get('/config');
  },

  setKimiConfig: async (payload, ctx: CoreProxyContext) => {
    return ctx.http.post('/config', payload);
  },

  // Safe degradation: KAP exposes no config warnings.
  getConfigDiagnostics: async () => ({ warnings: [] }),

  // Degraded: only flag values are available from config.experimental; registry
  // metadata (title/description/default/source) is not exposed by KAP.
  getExperimentalFeatures: async (_payload, ctx: CoreProxyContext) => {
    const config = (await ctx.http.get('/config')) as { experimental?: Record<string, boolean> };
    const experimental = config.experimental ?? {};
    return Object.entries(experimental).map(([id, enabled]) => ({
      id,
      enabled,
      // Registry metadata unavailable over KAP; surface minimal shape.
      source: 'config',
    }));
  },
};
