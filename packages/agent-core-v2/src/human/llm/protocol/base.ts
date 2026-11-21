import type { ModelCapability } from '#human/llm/capability';
import type { LlmModel } from '#human/llm/model';
import type { LlmErrorClassifier, LlmRequester } from '#human/llm/requester/requester';
import type { LlmLogger } from '#human/log/log';

import type { ProviderConnection } from './connection';

export type ProtocolName =
  | 'openai'
  | 'openai_responses'
  | 'anthropic'
  | 'google-genai'
  | 'antigravity';

export interface TraitContext {
  readonly model: LlmModel;
}

export interface ProtocolRequesterOptions<TTrait> {
  readonly connection?: ProviderConnection;
  readonly trait?: TTrait;
  readonly classifyError?: LlmErrorClassifier;
  readonly log?: LlmLogger;
}

export interface ProtocolBase<TTrait = unknown> {
  capability?(modelName: string): ModelCapability | undefined;
  createRequester(options?: ProtocolRequesterOptions<TTrait>): LlmRequester;
}
