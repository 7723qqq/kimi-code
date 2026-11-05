import { describe, expect, it } from 'bun:test';

import { evaluateRecall, formatEvaluation } from '#/features/associativeMemory/eval';

describe('evaluateRecall', () => {
  it('scores a perfect ranking', () => {
    const result = evaluateRecall([['a', 'b']], [['a']]);
    expect(result.hitAt1).toBe(1);
    expect(result.hitAt5).toBe(1);
    expect(result.mrr).toBe(1);
  });

  it('scores a miss', () => {
    const result = evaluateRecall([['x', 'y']], [['a']]);
    expect(result.hitAt1).toBe(0);
    expect(result.hitAt5).toBe(0);
    expect(result.mrr).toBe(0);
  });

  it('averages reciprocal ranks', () => {
    const result = evaluateRecall(
      [
        ['x', 'a'],
        ['a'],
      ],
      [['a'], ['a']],
    );
    expect(result.hitAt1).toBe(0.5);
    expect(result.mrr).toBeCloseTo((1 / 2 + 1) / 2, 5);
  });

  it('counts hit@5 only within k', () => {
    const result = evaluateRecall([['x', 'x', 'x', 'x', 'x', 'a']], [['a']], 5);
    expect(result.hitAt5).toBe(0);
    expect(result.hitAt1).toBe(0);
    expect(result.mrr).toBeCloseTo(1 / 6, 5);
  });

  it('handles no queries', () => {
    expect(evaluateRecall([], []).queries).toBe(0);
  });

  it('formats the metrics', () => {
    const text = formatEvaluation({ queries: 2, hitAt1: 0.5, hitAt5: 1, mrr: 0.75 });
    expect(text).toContain('hit@1: 0.500');
    expect(text).toContain('hit@5: 1.000');
    expect(text).toContain('mrr:   0.750');
  });
});
