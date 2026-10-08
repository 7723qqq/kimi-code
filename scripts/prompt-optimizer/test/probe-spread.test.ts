import { describe, expect, test } from 'bun:test';

import { combineSpreads, sampleSpread } from '../src/probe/probe';
import { runCase } from '../src/benchmark/runner';
import { getCaseById } from '../src/benchmark/cases';
import { generateBaselineVariant, loadPrompt } from '../src/prompt-parser';
import { loadConfig } from '../src/config';

describe('sampleSpread', () => {
  test('reports min, max and the sample count', () => {
    expect(sampleSpread([1, 0, 1, 0, 1])).toEqual({ min: 0, max: 1, samples: 5 });
  });

  test('a single sample has no spread to report', () => {
    // Which is why --reps 1 cannot reveal an inconsistent model.
    expect(sampleSpread([1])).toEqual({ min: 1, max: 1, samples: 1 });
  });

  test('consistent samples have zero spread', () => {
    expect(sampleSpread([1, 1, 1])).toEqual({ min: 1, max: 1, samples: 3 });
  });

  test('an empty sample list is handled without NaN', () => {
    expect(sampleSpread([])).toEqual({ min: 0, max: 0, samples: 0 });
  });

  test('combineSpreads widens to cover both conditions', () => {
    expect(combineSpreads({ min: 1, max: 1, samples: 3 }, { min: 0, max: 0.5, samples: 3 })).toEqual({
      min: 0,
      max: 1,
      samples: 6,
    });
  });
});

describe('tokenEfficiency counts every prompt token', () => {
  /**
   * The reported defect: `input + output` counted only tokens billed at full
   * rate, so a prompt served from cache looked almost free. Measured against
   * MiniMax, one prompt went from 1315 billed input tokens to 15 across two
   * identical calls, with the rest moving to `cache_read_input_tokens`.
   */
  const case_ = getCaseById('rule-no-emoji-default')!;
  const variant = generateBaselineVariant(loadPrompt(loadConfig().systemPromptPath).sections);
  const runner = { model: 'stub', apiBaseUrl: '', apiKey: '', concurrency: 1 };

  function callerWith(usage: { input: number; output: number; cacheRead?: number }) {
    return async () => ({ content: 'ok', toolCalls: [], usage, latencyMs: 1 });
  }

  test('includes cache-read tokens', async () => {
    const result = await runCase(
      case_,
      variant,
      callerWith({ input: 15, output: 10, cacheRead: 1236 }),
      runner,
    );
    expect(result.scores.tokenEfficiency).toBe(15 + 1236 + 10);
  });

  test('a fully-cached prompt is not reported as almost free', async () => {
    const warm = await runCase(
      case_,
      variant,
      callerWith({ input: 15, output: 10, cacheRead: 1236 }),
      runner,
    );
    const cold = await runCase(
      case_,
      variant,
      callerWith({ input: 1315, output: 10, cacheRead: 0 }),
      runner,
    );
    // Both processed ~1261 prompt tokens; the old metric differed by 88x.
    expect(Math.abs(warm.scores.tokenEfficiency - cold.scores.tokenEfficiency)).toBeLessThan(120);
  });

  test('a provider that reports no cache field still counts input and output', async () => {
    const result = await runCase(case_, variant, callerWith({ input: 100, output: 50 }), runner);
    expect(result.scores.tokenEfficiency).toBe(150);
  });
});
