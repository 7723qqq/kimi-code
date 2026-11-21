import Anthropic from '@anthropic-ai/sdk';

import { createAnthropicBase } from '#/llm/requester/bases/anthropic/requester';
import type { LlmClientContext } from '#/llm/requester/requester';
import { getLlmDispatcher } from '#/llm/requester/timeout';

export function createBedrockAnthropicClient(request: LlmClientContext): Anthropic {
  const dispatcher = getLlmDispatcher();
  return new Anthropic({
    apiKey: null,
    authToken: request.model.apiKey ?? null,
    baseURL: request.model.baseUrl ?? null,
    defaultHeaders: request.headers,
    maxRetries: 0,
    fetchOptions: dispatcher === undefined ? undefined : { dispatcher },
  });
}

export const bedrockAnthropicBase = createAnthropicBase({
  clientFactory: createBedrockAnthropicClient,
});
