import { describe, expect, it } from 'vitest';

import { parseOpenAIUsage } from '#/llm/requester/bases/openai/format';

describe('deepseek-v4.1-flash payloads captured from the live endpoint', () => {
  it('prices a real cache-hit response through the deepseek fields', () => {
    const usage = parseOpenAIUsage({
      prompt_tokens: 2011,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 1792,
      prompt_cache_miss_tokens: 219,
      cached_tokens: 0,
    });
    expect(usage).toMatchObject({ inputCacheRead: 1792, inputOther: 219, output: 1 });
    expect(usage!.inputCacheRead + usage!.inputOther).toBe(2011);
  });

  it('shows what the pre-change parser would have produced', () => {
    const raw = {
      prompt_tokens: 2011,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 1792,
      prompt_cache_miss_tokens: 219,
      cached_tokens: 0,
    };
    const withoutDeepSeekFields = parseOpenAIUsage({
      prompt_tokens: raw.prompt_tokens,
      completion_tokens: raw.completion_tokens,
      cached_tokens: raw.cached_tokens,
    });
    expect(withoutDeepSeekFields).toMatchObject({ inputCacheRead: 0, inputOther: 2011 });
    const withDeepSeekFields = parseOpenAIUsage(raw);
    expect(withDeepSeekFields).toMatchObject({ inputCacheRead: 1792, inputOther: 219 });
  });

  it('prices a real cache-miss response', () => {
    const usage = parseOpenAIUsage({
      prompt_tokens: 11,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 11,
      cached_tokens: 0,
    });
    expect(usage).toMatchObject({ inputCacheRead: 0, inputOther: 11 });
  });

  it('rejects a cache split that adds up to more than the prompt', () => {
    const usage = parseOpenAIUsage({
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 5000,
      prompt_cache_miss_tokens: 0,
      cached_tokens: 0,
    });
    expect(usage).toMatchObject({ inputCacheRead: 0, inputOther: 100 });
  });

  it('falls back to the OpenAI cached count when the DeepSeek split is rejected', () => {
    const usage = parseOpenAIUsage({
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 5000,
      prompt_cache_miss_tokens: 0,
      cached_tokens: 40,
    });
    expect(usage).toMatchObject({ inputCacheRead: 40, inputOther: 60 });
  });

  it('keeps a split that reports less than the prompt', () => {
    const usage = parseOpenAIUsage({
      prompt_tokens: 500,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 10,
      prompt_cache_miss_tokens: 20,
      cached_tokens: 0,
    });
    expect(usage).toMatchObject({ inputCacheRead: 10, inputOther: 20 });
  });

  it('reports the rejected split through the supplied logger', () => {
    const warnings: { message: string; payload?: unknown }[] = [];
    const usage = parseOpenAIUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 1,
        prompt_cache_hit_tokens: 5000,
        prompt_cache_miss_tokens: 0,
      },
      { warn: (message, payload) => warnings.push({ message, payload }) },
    );
    expect(usage).toMatchObject({ inputCacheRead: 0, inputOther: 100 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/cache fields disagree/);
    expect(warnings[0]?.payload).toMatchObject({
      promptTokens: 100,
      promptCacheHitTokens: 5000,
      promptCacheMissTokens: 0,
    });
  });

  it('stays silent when the split is accepted and when no logger is given', () => {
    const warnings: string[] = [];
    const log = { warn: (message: string) => warnings.push(message) };
    parseOpenAIUsage(
      { prompt_tokens: 2011, completion_tokens: 1, prompt_cache_hit_tokens: 1792, prompt_cache_miss_tokens: 219 },
      log,
    );
    parseOpenAIUsage({
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 5000,
      prompt_cache_miss_tokens: 0,
    });
    expect(warnings).toEqual([]);
  });
});
