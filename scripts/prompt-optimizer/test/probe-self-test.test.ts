import { describe, expect, test } from 'bun:test';

import { ProbeSelfTestError, assertScorersSelfTest } from '../src/probe/probe';

/**
 * The self-test mechanism is the guard that makes the other probe defects
 * impossible to reintroduce: every scorer declares samples it must satisfy, and
 * `runProbe` checks them before spending a model call.
 *
 * The task list is private, so these exercise the mechanism through a stub task.
 */
type Task = Parameters<typeof assertScorersSelfTest>[0][number];

function task(overrides: Partial<Task> & Pick<Task, 'scorer' | 'selfTest'>): Task {
  return {
    dimension: 'negation-compliance',
    description: 'stub',
    systemPrompt: '',
    userMessage: '',
    recommendation: '',
    ...overrides,
  };
}

describe('assertScorersSelfTest', () => {
  test('a correct scorer passes', () => {
    const correct = task({
      scorer: (r) => (r.includes('ok') ? 1 : 0),
      selfTest: [
        ['ok', 1],
        ['nope', 0],
      ],
    });
    expect(() => assertScorersSelfTest([correct])).not.toThrow();
  });

  // The shape of the reported priority-reasoning defect: the scorer is the
  // wrong way round, so it awards full marks for the behaviour the case forbids.
  test('an inverted scorer is caught', () => {
    const inverted = task({
      scorer: (r) => (r.includes('bad') ? 1 : 0),
      selfTest: [
        ['bad', 0],
        ['good', 1],
      ],
    });
    expect(() => assertScorersSelfTest([inverted])).toThrow(ProbeSelfTestError);
    expect(() => assertScorersSelfTest([inverted])).toThrow(/negation-compliance/);
  });

  // The shape of the reported negation-compliance defect: penalties that cannot
  // reach zero leave a model that broke every rule looking partly compliant.
  test('a scorer that cannot reach zero is caught', () => {
    const floored = task({
      scorer: () => 0.25,
      selfTest: [['broken everything', 0]],
    });
    expect(() => assertScorersSelfTest([floored])).toThrow(/got 0\.25/);
  });

  test('the message names the sample, the expectation and the actual value', () => {
    const wrong = task({
      scorer: () => 1,
      selfTest: [['some response', 0]],
    });
    expect(() => assertScorersSelfTest([wrong])).toThrow(/some response/);
    expect(() => assertScorersSelfTest([wrong])).toThrow(/expected 0/);
    expect(() => assertScorersSelfTest([wrong])).toThrow(/got 1/);
  });

  test('the real task list passes its own self-tests', () => {
    // With no argument it checks the shipped PROBE_TASKS, which is what
    // runProbe does before any model call.
    expect(() => assertScorersSelfTest()).not.toThrow();
  });
});

describe('the shipped scorers behave as their dimension names claim', () => {
  // Imported indirectly: runProbe is the only public entry, and it self-tests
  // first, so a passing runProbe *is* the assertion for the real task list.
  test('a probe run over a stub caller completes without a self-test failure', async () => {
    const { runProbe } = await import('../src/probe/probe');
    const caller = async () => ({
      content: 'a generic response',
      toolCalls: [],
      usage: { input: 1, output: 1 },
      latencyMs: 1,
    });
    const profile = await runProbe({
      runner: { model: 'stub', apiBaseUrl: '', apiKey: '', concurrency: 1 },
      caller,
      repetitions: 1,
    });
    expect(profile.dimensions).toHaveLength(6);
  });
});
