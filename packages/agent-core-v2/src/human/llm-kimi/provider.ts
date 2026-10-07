import { createProvider } from '#/llm/provider/definition';
import { anthropicBetaBase } from '#/llm/requester/bases/anthropic/requester';
import { openAIResponsesBase } from '#/llm/requester/bases/openai-responses/requester';
import { openAIBase } from '#/llm/requester/bases/openai/requester';

import { classifyKimiQuotaError } from './errors';
import { kimiMediaContribution } from './media';
import { kimiAnthropicTrait, kimiConnection, kimiOpenAITrait, kimiResponsesTrait } from './trait';

export const kimiProvider = createProvider({
  id: 'kimi',
  protocols: {
    openai: {
      base: openAIBase,
      trait: kimiOpenAITrait,
      connection: kimiConnection,
      classifyError: classifyKimiQuotaError,
    },
    anthropic: {
      base: anthropicBetaBase,
      trait: kimiAnthropicTrait,
      connection: kimiConnection,
      classifyError: classifyKimiQuotaError,
    },
    openai_responses: {
      base: openAIResponsesBase,
      trait: kimiResponsesTrait,
      connection: kimiConnection,
      classifyError: classifyKimiQuotaError,
    },
  },
  media: kimiMediaContribution,
});
