import { describe, expect, test } from 'bun:test';

import { BENCHMARK_CASES } from '../src/benchmark/cases';
import {
  SUPPORTED_EVALUATOR_TYPES,
  assertSupportedEvaluators,
  runEvaluator,
  runAllEvaluators,
} from '../src/benchmark/evaluators';

const ctx = { output: 'anything', toolCalls: [], tokenUsage: { input: 0, output: 0 } };

/**
 * `llm-judge` was removed rather than left declared: a judge needs a second
 * model call, which `runEvaluator` cannot make, so every case declaring one
 * scored 0 and read as a permanent violation. These tests pin the replacement
 * behaviour — an unsupported evaluator is refused, naming itself.
 */
describe('unsupported evaluator types are refused', () => {
  test('the supported set matches the types the runner handles', () => {
    expect(SUPPORTED_EVALUATOR_TYPES).not.toContain('llm-judge' as never);
    expect(SUPPORTED_EVALUATOR_TYPES).toContain('json-schema');
    expect(SUPPORTED_EVALUATOR_TYPES).toHaveLength(8);
  });

  test('a case declaring a judge is refused at load, naming the case', () => {
    expect(() =>
      assertSupportedEvaluators([
        { id: 'case-42', evaluators: [{ name: 'j', type: 'llm-judge', params: {} } as never] },
      ]),
    ).toThrow(/case-42/);
    expect(() =>
      assertSupportedEvaluators([
        { id: 'case-42', evaluators: [{ name: 'j', type: 'llm-judge', params: {} } as never] },
      ]),
    ).toThrow(/llm-judge/);
  });

  test('the error lists what is supported', () => {
    expect(() =>
      assertSupportedEvaluators([
        { id: 'c', evaluators: [{ name: 'x', type: 'made-up', params: {} } as never] },
      ]),
    ).toThrow(/Supported: contains/);
  });

  test('a supported evaluator set passes validation unchanged', () => {
    expect(() =>
      assertSupportedEvaluators([
        { id: 'ok', evaluators: [{ name: 'c', type: 'contains', params: { text: 'x' } }] },
      ]),
    ).not.toThrow();
  });

  test('the shipped case set declares only supported evaluators', () => {
    expect(() => assertSupportedEvaluators(BENCHMARK_CASES)).not.toThrow();
    for (const benchCase of BENCHMARK_CASES) {
      for (const evaluator of benchCase.evaluators) {
        expect(
          SUPPORTED_EVALUATOR_TYPES as readonly string[],
          `case ${benchCase.id} evaluator ${evaluator.name}`,
        ).toContain(evaluator.type);
      }
    }
  });
});

describe('runAllEvaluators still aggregates deterministic evaluators', () => {
  test('scores and violations are computed from pass', () => {
    const result = runAllEvaluators(
      [
        { name: 'has-x', type: 'contains', params: { text: 'x' } },
        { name: 'has-z', type: 'contains', params: { text: 'z' } },
      ],
      { ...ctx, output: 'x marks the spot' },
    );
    expect(result.ruleCompliance).toBe(0.5);
    expect(result.violations).toEqual(['has-z']);
  });

  test('runEvaluator returns an outcome for a supported type', () => {
    const outcome = runEvaluator(
      { name: 'c', type: 'contains', params: { text: 'any' } },
      { ...ctx, output: 'anything' },
    );
    expect(outcome.pass).toBe(true);
    expect(outcome.name).toBe('c');

    const missing = runEvaluator(
      { name: 'm', type: 'contains', params: { text: 'absent' } },
      { ...ctx, output: 'anything' },
    );
    expect(missing.pass).toBe(false);
  });
});
