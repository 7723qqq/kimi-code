import type { TokenUsage } from '#/llm/usage';
import type { LlmLogger } from '#/log/log';

import type { OpenAIRawUsage } from './contract';

export interface OpenAICacheFields {
  readonly cached: number;
  readonly miss: number | undefined;
  /** True when the DeepSeek split was present but rejected as self-contradictory. */
  readonly rejected: boolean;
  /** The rejected `prompt_cache_miss_tokens`, kept for reporting after `miss` is cleared. */
  readonly reportedMiss?: number;
}

/**
 * Read the cache fields of an OpenAI-compatible usage object.
 *
 * DeepSeek reports its cache split in top-level `prompt_cache_hit_tokens` /
 * `prompt_cache_miss_tokens`; OpenAI and Moonshot report a single cached count in
 * `cached_tokens` or `prompt_tokens_details.cached_tokens`. When the DeepSeek pair is
 * present but its parts sum to more than `prompt_tokens`, the fields cannot both be
 * right, so they are rejected and the OpenAI fields are used instead. A sum that is
 * merely less than `prompt_tokens` is not an error: an endpoint may report only part
 * of the split.
 */
export function readOpenAICacheFields(usage: OpenAIRawUsage): OpenAICacheFields {
  const cachedTokens = usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const hit = usage.prompt_cache_hit_tokens;
  if (hit === undefined) return { cached: cachedTokens, miss: undefined, rejected: false };
  const miss = usage.prompt_cache_miss_tokens;
  if (miss !== undefined && hit + miss > (usage.prompt_tokens ?? 0)) {
    return { cached: cachedTokens, miss: undefined, rejected: true, reportedMiss: miss };
  }
  return { cached: hit, miss, rejected: false };
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
