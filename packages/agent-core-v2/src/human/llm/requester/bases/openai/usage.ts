import type { TokenUsage } from '#/llm/usage';
import type { LlmLogger } from '#/log/log';

import type { OpenAIRawUsage } from './contract';

export type OpenAICacheSplit =
  | { readonly kind: 'split'; readonly cached: number; readonly miss: number | undefined }
  | { readonly kind: 'contradiction'; readonly cached: number; readonly reportedMiss: number }
  | { readonly kind: 'absent'; readonly cached: number };

export function classifyDeepSeekCacheSplit(
  hit: unknown,
  miss: unknown,
  promptTokens: number,
  fallbackCached: number,
): OpenAICacheSplit {
  if (typeof hit !== 'number') return { kind: 'absent', cached: fallbackCached };
  if (typeof miss === 'number' && hit + miss > promptTokens) {
    return { kind: 'contradiction', cached: fallbackCached, reportedMiss: miss };
  }
  return { kind: 'split', cached: hit, miss: typeof miss === 'number' ? miss : undefined };
}

export function readOpenAICacheFields(usage: OpenAIRawUsage): OpenAICacheSplit {
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
  const split = readOpenAICacheFields(usage);
  if (split.kind === 'contradiction') {
    log?.warn('openai usage cache fields disagree; falling back to the cached count', {
      promptTokens,
      promptCacheHitTokens: usage.prompt_cache_hit_tokens,
      promptCacheMissTokens: split.reportedMiss,
    });
  }
  const miss = split.kind === 'split' ? split.miss : undefined;
  return {
    inputOther: miss ?? Math.max(promptTokens - split.cached, 0),
    output: usage.completion_tokens ?? 0,
    inputCacheRead: split.cached,
    inputCacheCreation: 0,
    raw: usage as Record<string, unknown>,
  };
}
