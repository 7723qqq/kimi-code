import { createProvider } from '#human/llm/provider/definition';
import { anthropicBetaBase } from '#human/llm/requester/bases/anthropic/requester';
import { openAIResponsesBase } from '#human/llm/requester/bases/openai-responses/requester';
import { openAIBase } from '#human/llm/requester/bases/openai/requester';

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
