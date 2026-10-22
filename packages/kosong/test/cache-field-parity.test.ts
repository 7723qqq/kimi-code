import { describe, expect, it } from 'bun:test';

import { extractUsage } from '#/providers/openai-common';
import { extractResponsesUsage } from '#/providers/openai-responses';
import { extractAnthropicUsage } from '#/providers/anthropic-usage';

// The v2 engine's OpenAI-compatible usage reader. Imported by relative path on
// purpose: the two engines have separate copies of this rule and no shared
// package can hold one, so this file's whole job is to fail the moment the two
// copies stop agreeing. `kosong` cannot import the engine (this package is the
// frozen legacy kernel and the engine's boundary check forbids the reverse
// direction too), which is exactly why the agreement is asserted from outside
// both rather than enforced by a single implementation.
import { parseOpenAIUsage } from '../../agent-core-v2/src/human/llm/requester/bases/openai/usage';
import { parseOpenAIResponsesUsage } from '../../agent-core-v2/src/human/llm/requester/bases/openai-responses/format';
import type { StreamParseSink } from '../../agent-core-v2/src/human/llm/protocol/format';
import { anthropicFormat } from '../../agent-core-v2/src/human/llm/requester/bases/anthropic/format';

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

interface ResponsesCase {
  readonly name: string;
  readonly usage: Record<string, unknown>;
  readonly inputOther: number;
  readonly cacheRead: number;
  /** True when the engine's Responses reader must reach the same numbers. */
  readonly parity: boolean;
}

/**
 * The Responses reader classifies the same DeepSeek split as the Chat
 * Completions reader, including the contradictory payload that must be
 * rejected. `input_tokens` / `output_tokens` / `input_tokens_details` are the
 * Responses spelling of the counters.
 */
const RESPONSES_CASES: readonly ResponsesCase[] = [
  {
    name: 'contradictory split falls back to the standard cached count',
    usage: {
      input_tokens: 100,
      output_tokens: 1,
      prompt_cache_hit_tokens: 5000,
      prompt_cache_miss_tokens: 0,
      input_tokens_details: { cached_tokens: 40 },
    },
    inputOther: 60,
    cacheRead: 40,
    parity: true,
  },
  {
    name: 'contradictory split with no fallback keeps the whole prompt as fresh input',
    usage: {
      input_tokens: 100,
      output_tokens: 1,
      prompt_cache_hit_tokens: 5000,
      prompt_cache_miss_tokens: 0,
    },
    inputOther: 100,
    cacheRead: 0,
    parity: true,
  },
  {
    name: 'consistent split is kept verbatim',
    usage: {
      input_tokens: 500,
      output_tokens: 1,
      prompt_cache_hit_tokens: 120,
      prompt_cache_miss_tokens: 380,
    },
    inputOther: 380,
    cacheRead: 120,
    parity: false,
  },
];

describe('responses cache-field classification agrees across engines', () => {
  // The engine's Responses reader does not read the DeepSeek split at all, so
  // the two implementations must agree on the payloads where the split is
  // REJECTED — that is the dimension this fix aligned.
  for (const testCase of RESPONSES_CASES.filter((c) => c.parity)) {
    it(testCase.name, () => {
      const kosong = extractResponsesUsage(testCase.usage);
      const engine = parseOpenAIResponsesUsage(testCase.usage);

      expect(engine).toBeDefined();
      expect(kosong.inputCacheRead).toBe(testCase.cacheRead);
      expect(kosong.inputOther).toBe(testCase.inputOther);
      expect(engine!.inputCacheRead).toBe(kosong.inputCacheRead);
      expect(engine!.inputOther).toBe(kosong.inputOther);
      // Never let the two buckets claim more than the prompt reports.
      expect(kosong.inputCacheRead + kosong.inputOther).toBeLessThanOrEqual(
        (testCase.usage['input_tokens'] as number) ?? Infinity,
      );
    });
  }

  it('keeps a consistent DeepSeek split verbatim instead of treating it as a total', () => {
    // The engine's Responses reader reports no cache read here; kosong keeps
    // the split as its own buckets (the payload is self-consistent, so there
    // is nothing to reject). Documented so the divergence is not a surprise.
    const testCase = RESPONSES_CASES.find((c) => !c.parity)!;
    const kosong = extractResponsesUsage(testCase.usage);

    expect(kosong.inputCacheRead).toBe(testCase.cacheRead);
    expect(kosong.inputOther).toBe(testCase.inputOther);
  });
});

interface AnthropicCase {
  readonly name: string;
  readonly type: 'message_start' | 'message_delta';
  readonly usage: Record<string, number>;
  readonly inputOther: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

/**
 * Anthropic's cache fields are SIBLINGS of `input_tokens`, not parts of it — a
 * real capture reads `input_tokens: 11` next to `cache_read_input_tokens: 1434`.
 * Both readers must therefore copy every field verbatim; the sum is allowed to
 * exceed `input_tokens`, and asserting that here is what stops anyone from
 * reintroducing the subtraction that drove cache-hit turns to 0.
 */
const ANTHROPIC_CASES: readonly AnthropicCase[] = [
  {
    name: 'real capture: cache read dwarfs input_tokens',
    type: 'message_start',
    usage: {
      input_tokens: 11,
      output_tokens: 1,
      cache_read_input_tokens: 1434,
      cache_creation_input_tokens: 0,
    },
    inputOther: 11,
    output: 1,
    cacheRead: 1434,
    cacheCreation: 0,
  },
  {
    name: 'message_start with all three split fields',
    type: 'message_start',
    usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    inputOther: 10,
    output: 0,
    cacheRead: 3,
    cacheCreation: 2,
  },
  {
    name: 'message_delta with every counter present',
    type: 'message_delta',
    usage: {
      output_tokens: 42,
      cache_read_input_tokens: 55,
      cache_creation_input_tokens: 25,
      input_tokens: 105,
    },
    inputOther: 105,
    output: 42,
    cacheRead: 55,
    cacheCreation: 25,
  },
];

function engineAnthropicUsage(testCase: AnthropicCase): Record<string, number> {
  const patch: Record<string, number> = {};
  const sink: StreamParseSink = {
    onDelta: () => {},
    onFinish: () => {},
    onUsage: (usage) => {
      for (const [key, value] of Object.entries(usage)) {
        if (typeof value === 'number') patch[key] = value;
      }
    },
  };
  const chunk =
    testCase.type === 'message_start'
      ? { type: 'message_start', message: { id: 'msg_parity', usage: testCase.usage } }
      : { type: 'message_delta', delta: {}, usage: testCase.usage };
  anthropicFormat.createStreamParser()(chunk as never, sink);
  return patch;
}

describe('anthropic cache-field classification agrees across engines', () => {
  for (const testCase of ANTHROPIC_CASES) {
    it(testCase.name, () => {
      const kosong = extractAnthropicUsage(testCase.usage as never);
      const engine = engineAnthropicUsage(testCase);

      expect(kosong).toEqual({
        inputOther: testCase.inputOther,
        output: testCase.output,
        inputCacheRead: testCase.cacheRead,
        inputCacheCreation: testCase.cacheCreation,
      });
      expect(engine['inputOther']).toBe(testCase.inputOther);
      expect(engine['inputCacheRead']).toBe(testCase.cacheRead);
      expect(engine['inputCacheCreation']).toBe(testCase.cacheCreation);
      // The engine suppresses `output` on `message_start` (the v2 parser deletes
      // the field for that event); the delta event carries the output count.
      if (testCase.type === 'message_delta') {
        expect(engine['output']).toBe(testCase.output);
      }
      expect(engine['inputOther']).toBe(kosong.inputOther);
      expect(engine['inputCacheRead']).toBe(kosong.inputCacheRead);
    });
  }

  it('allows inputOther + cache fields to exceed input_tokens', () => {
    // The whole point of the fix: these are siblings. Any reader that keeps
    // the sum inside `input_tokens` is subtracting again.
    const captured = ANTHROPIC_CASES[0]!;
    const kosong = extractAnthropicUsage(captured.usage as never);
    expect(kosong.inputOther + kosong.inputCacheRead).toBeGreaterThan(captured.usage['input_tokens']!);
  });
});
