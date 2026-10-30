import type { LlmRequestProjection } from '#/agent/llmRequester/llmRequestOps';
import type { ThinkingEffort } from '#human/llm/thinking';
import { inputTotal, type TokenUsage } from '#human/llm/usage';

export interface CacheObservation {
  readonly modelAlias: string;
  readonly protocol?: string;
  readonly providerType?: string;
  readonly messageCount: number;
  readonly historyHash: string;
  readonly projection?: LlmRequestProjection;
  readonly thinkingEffort?: ThinkingEffort;
  readonly inputTokens?: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly outputTokens: number;
}

export interface CacheObservationInput {
  readonly modelAlias: string;
  readonly protocol?: string;
  readonly providerType?: string;
  readonly messageCount: number;
  readonly historyHash: string;
  readonly projection?: LlmRequestProjection;
  readonly thinkingEffort?: ThinkingEffort;
  readonly usage?: TokenUsage;
}

export function buildCacheObservation(input: CacheObservationInput): CacheObservation {
  const usage = input.usage;
  return {
    modelAlias: input.modelAlias,
    protocol: input.protocol,
    providerType: input.providerType,
    messageCount: input.messageCount,
    historyHash: input.historyHash,
    projection: input.projection,
    thinkingEffort: input.thinkingEffort,
    inputTokens: usage === undefined ? undefined : inputTotal(usage),
    cacheRead: usage?.inputCacheRead ?? 0,
    cacheCreation: usage?.inputCacheCreation ?? 0,
    outputTokens: usage?.output ?? 0,
  };
}
