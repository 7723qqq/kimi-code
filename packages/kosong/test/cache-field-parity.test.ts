import { describe, expect, it } from 'vitest';

import { extractUsage } from '#/providers/openai-common';

// The v2 engine's OpenAI-compatible usage reader. Imported by relative path on
// purpose: the two engines have separate copies of this rule and no shared
// package can hold one, so this file's whole job is to fail the moment the two
// copies stop agreeing. `kosong` cannot import the engine (this package is the
// frozen legacy kernel and the engine's boundary check forbids the reverse
// direction too), which is exactly why the agreement is asserted from outside
// both rather than enforced by a single implementation.
import { parseOpenAIUsage } from '../../agent-core-v2/src/human/llm/requester/bases/openai/usage';

interface Case {
  readonly name: string;
  readonly usage: Record<string, unknown>;
  readonly cacheRead: number;
  readonly inputOther: number;
}

/**
 * Both sides are handed the same payloads and must classify them identically.
 * `inputCacheCreation` is expected to be 0 on both — neither engine bills a
 * cache-write counter for this wire.
 */
const CASES: readonly Case[] = [
  {
    name: 'deepseek cache split within the prompt total',
    usage: {
      prompt_tokens: 2011,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 1792,
      prompt_cache_miss_tokens: 219,
      cached_tokens: 0,
    },
    cacheRead: 1792,
    inputOther: 219,
  },
  {
    name: 'deepseek cache miss only',
    usage: {
      prompt_tokens: 11,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 11,
      cached_tokens: 0,
    },
    cacheRead: 0,
    inputOther: 11,
  },
  {
    name: 'contradictory split rejected, openai cached count used',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 5000,
      prompt_cache_miss_tokens: 0,
      cached_tokens: 40,
    },
    cacheRead: 40,
    inputOther: 60,
  },
  {
    name: 'contradictory split rejected with no fallback',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 5000,
      prompt_cache_miss_tokens: 0,
      cached_tokens: 0,
    },
    cacheRead: 0,
    inputOther: 100,
  },
  {
    name: 'partial split is not an error',
    usage: {
      prompt_tokens: 500,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 10,
      prompt_cache_miss_tokens: 20,
      cached_tokens: 0,
    },
    cacheRead: 10,
    inputOther: 20,
  },
  {
    name: 'moonshot top-level cached_tokens',
    usage: { prompt_tokens: 500, completion_tokens: 1, cached_tokens: 120 },
    cacheRead: 120,
    inputOther: 380,
  },
  {
    name: 'openai nested prompt_tokens_details.cached_tokens',
    usage: {
      prompt_tokens: 500,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 130 },
    },
    cacheRead: 130,
    inputOther: 370,
  },
  {
    name: 'no cache fields at all',
    usage: { prompt_tokens: 500, completion_tokens: 1 },
    cacheRead: 0,
    inputOther: 500,
  },
];

describe('deepseek cache-field classification agrees across engines', () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const kosong = extractUsage(testCase.usage);
      const engine = parseOpenAIUsage(testCase.usage);

      expect(kosong).not.toBeNull();
      expect(engine).toBeDefined();

      expect({ cacheRead: kosong!.inputCacheRead, inputOther: kosong!.inputOther }).toEqual({
        cacheRead: testCase.cacheRead,
        inputOther: testCase.inputOther,
      });
      expect({
        cacheRead: engine!.inputCacheRead,
        inputOther: engine!.inputOther,
      }).toEqual({
        cacheRead: testCase.cacheRead,
        inputOther: testCase.inputOther,
      });
      // The two engines must not just match the expectation, but each other.
      expect(engine!.inputCacheRead).toBe(kosong!.inputCacheRead);
      expect(engine!.inputOther).toBe(kosong!.inputOther);
      expect(engine!.output).toBe(kosong!.output);
    });
  }

  it('keeps the cache split inside the reported prompt total', () => {
    for (const testCase of CASES) {
      const engine = parseOpenAIUsage(testCase.usage);
      const prompt = testCase.usage['prompt_tokens'] as number;
      expect(engine!.inputCacheRead + engine!.inputOther).toBeLessThanOrEqual(prompt);
    }
  });
});
