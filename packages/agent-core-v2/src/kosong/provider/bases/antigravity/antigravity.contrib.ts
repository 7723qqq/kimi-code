import { registerProtocolBase } from '#/kosong/protocol/protocolBase';

import { getAntigravityModelCapability, AntigravityChatProvider } from './antigravity';

registerProtocolBase({
  id: 'antigravity',
  capability: getAntigravityModelCapability,
  createChatProvider({ config }) {
    return new AntigravityChatProvider({
      model: config.modelName,
      thinkingEffort: config.providerOptions?.adaptiveThinking ? 'high' : undefined,
    });
  },
});
