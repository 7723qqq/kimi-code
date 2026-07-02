/**
 * LLM contract for the model capability used by the stateless loop.
 *
 * The immutable `LLM` object owns provider/model metadata, capability metadata,
 * and the system prompt. Other host concerns are injected through separate
 * surfaces.
 */

import type { ModelCapability } from '@moonshot-ai/kosong';
import type {
  LLMRequestFinish,
  LLMRequestOverrides,
  LLMRequestPartHandler,
} from '#/agent/llmRequester';

export interface LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability?: ModelCapability | undefined;
  request(
    overrides?: LLMRequestOverrides,
    onPart?: LLMRequestPartHandler,
    signal?: AbortSignal,
  ): Promise<LLMRequestFinish>;
}
