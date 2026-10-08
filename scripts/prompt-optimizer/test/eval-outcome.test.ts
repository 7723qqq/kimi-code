import { describe, expect, test } from 'bun:test';

import { runAllEvaluators, runEvaluator } from '../src/benchmark/evaluators';
import type { Evaluator } from '../src/types';

const ctx = (output: string) => ({ output, toolCalls: [], tokenUsage: { input: 0, output: 0 } });

/** A regex that matches half the time, so a partial score is easy to produce. */
function partial(name = 'p', threshold?: number): Evaluator {
  const params: Record<string, unknown> = { pattern: '^a' };
  if (threshold !== undefined) params['threshold'] = threshold;
  return { name, type: 'regex-match', params };
}

describe('runEvaluator separates pass from score', () => {
  test('returns score, pass and name', () => {
    const result = runEvaluator(partial(), ctx('abc'));
    expect(result.name).toBe('p');
    expect(result.score).toBe(1);
    expect(result.pass).toBe(true);
  });

  test('a failing score does not pass by default', () => {
    const result = runEvaluator(partial(), ctx('zzz'));
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
  });

  // The behaviour the split exists for: a partial score the case accepts.
  test('a threshold lets a partial score pass', () => {
    // output-length degrades gracefully, so it produces values between 0 and 1.
    const evaluator: Evaluator = {
      name: 'lenient',
      type: 'output-length',
      // 4 lines against a 3-line budget scores 1 - 1/3 ≈ 0.667.
      params: { maxLines: 3, threshold: 0.5 },
    };
    const result = runEvaluator(evaluator, ctx('a\nb\nc\nd'));
    expect(result.score).toBeCloseTo(2 / 3, 6);
    expect(result.pass).toBe(true);
  });

  test('the same partial score fails without a threshold', () => {
    const evaluator: Evaluator = {
      name: 'strict',
      type: 'output-length',
      params: { maxLines: 3 },
    };
    const result = runEvaluator(evaluator, ctx('a\nb\nc\nd'));
    expect(result.score).toBeCloseTo(2 / 3, 6);
    expect(result.pass).toBe(false);
  });
});

describe('runAllEvaluators counts violations by pass', () => {
  test('a partial score above its threshold is not a violation', () => {
    const lenient: Evaluator = {
      name: 'ok',
      type: 'output-length',
      params: { maxLines: 3, threshold: 0.5 },
    };
    const result = runAllEvaluators([lenient], ctx('a\nb\nc\nd'));
    expect(result.violations).toEqual([]);
    expect(result.ruleCompliance).toBeCloseTo(2 / 3, 6);
  });

  test('a partial score below its threshold is a violation', () => {
    const strict: Evaluator = {
      name: 'bad',
      type: 'output-length',
      params: { maxLines: 3, threshold: 0.95 },
    };
    const result = runAllEvaluators([strict], ctx('a\nb\nc\nd'));
    expect(result.violations).toEqual(['bad']);
  });

  test('ruleCompliance remains the mean score', () => {
    const result = runAllEvaluators(
      [
        { name: 'hit', type: 'contains', params: { text: 'x' } },
        { name: 'miss', type: 'contains', params: { text: 'zzz' } },
      ],
      ctx('x marks the spot'),
    );
    expect(result.ruleCompliance).toBe(0.5);
    expect(result.violations).toEqual(['miss']);
  });

  test('no evaluators means full compliance and no violations', () => {
    expect(runAllEvaluators([], ctx('anything'))).toEqual({
      ruleCompliance: 1,
      violations: [],
    });
  });
});
