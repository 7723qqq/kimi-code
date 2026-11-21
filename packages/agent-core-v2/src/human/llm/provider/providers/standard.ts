import type { ProviderConnection } from '#human/llm/protocol/connection';
import { createProvider } from '#human/llm/provider/definition';
import { anthropicBase } from '#human/llm/requester/bases/anthropic/requester';
import { antigravityBase } from '#human/llm/requester/bases/antigravity/requester';
import type { AntigravityTrait } from '#human/llm/requester/bases/antigravity/trait';
import { googleGenAIBase } from '#human/llm/requester/bases/google-genai/requester';
import { openAIResponsesBase } from '#human/llm/requester/bases/openai-responses/requester';
import { openAIBase } from '#human/llm/requester/bases/openai/requester';

const openAIConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' }),
};

const anthropicConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' }),
};

export const googleGenAIConnection: ProviderConnection = {
  endpoint: (ctx) =>
    ctx?.model.vertexai === true
      ? { apiKeyEnv: 'VERTEXAI_API_KEY', baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL' }
      : { apiKeyEnv: 'GOOGLE_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' },
};

export const openaiProvider = createProvider({
  id: 'openai',
  protocols: {
    openai: { base: openAIBase, connection: openAIConnection },
    openai_responses: { base: openAIResponsesBase, connection: openAIConnection },
  },
});

export const anthropicProvider = createProvider({
  id: 'anthropic',
  protocols: {
    anthropic: { base: anthropicBase, connection: anthropicConnection },
  },
});

export const googleProvider = createProvider({
  id: 'google',
  protocols: {
    'google-genai': { base: googleGenAIBase, connection: googleGenAIConnection },
  },
  media: { inlineVideo: true },
});

const antigravityTrait: AntigravityTrait = {};

export const antigravityProvider = createProvider({
  id: 'antigravity',
  protocols: {
    antigravity: { base: antigravityBase, trait: antigravityTrait },
  },
});
