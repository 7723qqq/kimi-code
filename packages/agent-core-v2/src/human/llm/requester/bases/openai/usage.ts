import type { TokenUsage } from '#/llm/usage';
import type { LlmLogger } from '#/log/log';

import type { OpenAIRawUsage } from './contract';

export interface OpenAICacheFields {
  readonly cached: number;
  readonly miss: number | undefined;
  readonly rejected: boolean;
  readonly reportedMiss?: number;
}

export function classifyDeepSeekCacheSplit(
  hit: unknown,
  miss: unknown,
  promptTokens: number,
  fallbackCached: number,
): OpenAICacheFields {
  if (typeof hit !== 'number') return { cached: fallbackCached, miss: undefined, rejected: false };
  if (typeof miss === 'number' && hit + miss > promptTokens) {
    return { cached: fallbackCached, miss: undefined, rejected: true, reportedMiss: miss };
  }
  return { cached: hit, miss: typeof miss === 'number' ? miss : undefined, rejected: false };
}

export function readOpenAICacheFields(usage: OpenAIRawUsage): OpenAICacheFields {
  const cachedTokens =
    usage.cached_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_tokens_details?.cached_tokens ??
    0;
  return classifyDeepSeekCacheSplit(
    usage.prompt_cache_hit_tokens,
    usage.prompt_cache_miss_tokens,
    usage.prompt_tokens ?? 0,
    cachedTokens,
  );
}

export function parseOpenAIUsage(
  usage: OpenAIRawUsage | null | undefined,
  log?: LlmLogger,
): TokenUsage | undefined {
  if (usage === null || usage === undefined) {
    return undefined;
  }
  const promptTokens = usage.prompt_tokens ?? 0;
  const { cached, miss, rejected, reportedMiss } = readOpenAICacheFields(usage);
  if (rejected) {
    log?.warn('openai usage cache fields disagree; falling back to the cached count', {
      promptTokens,
      promptCacheHitTokens: usage.prompt_cache_hit_tokens,
      promptCacheMissTokens: reportedMiss,
    });
  }
  return {
    inputOther: miss ?? Math.max(promptTokens - cached, 0),
    output: usage.completion_tokens ?? 0,
    inputCacheRead: cached,
    inputCacheCreation: 0,
    raw: usage as Record<string, unknown>,
  };
}
