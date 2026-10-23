import { describe, expect, test } from 'bun:test';

import { CORE_BEHAVIOR_CONTRACT_IDS } from '../../../packages/agent-core-v2/src/app/agentProfileCatalog/behaviorContract';
import { BENCHMARK_CASES, getCaseById } from '../src/benchmark/cases';
import {
  ModelFailureError,
  classifyCallFailure,
  reminderPrelude,
  renderedMessages,
  runRenderedCase,
  runRenderedSuite,
  type LLMCaller,
  type RenderedInput,
  type RunnerConfig,
} from '../src/benchmark/runner';
import type { BenchmarkCase } from '../src/types';

const runner: RunnerConfig = { model: 'test-model', apiBaseUrl: '', apiKey: '', concurrency: 2 };

function benchCase(overrides: Partial<BenchmarkCase> & Pick<BenchmarkCase, 'id'>): BenchmarkCase {
  return {
    description: overrides.id,
    category: 'rule-compliance',
    userMessages: ['hello'],
    relevantSections: [],
    evaluators: [{ name: 'says-x', type: 'contains', params: { text: 'x' } }],
    ...overrides,
  };
}

function okCaller(content = 'x'): LLMCaller {
  return async () => ({ content, toolCalls: [], usage: { input: 10, output: 5 }, latencyMs: 1 });
}

function renderedInput(overrides: Partial<RenderedInput> = {}): RenderedInput {
  return {
    name: 'full',
    system: 'SYSTEM TEXT',
    profile: 'full',
    sourceHash: 'abcdef0123456789',
    fixtureSummary: { agentsMd: 'fixture', agentsMdChars: 12 },
    contractDelivery: [
      { id: 'authority_and_untrusted_content', channel: 'system' },
      { id: 'communication', channel: 'reminder' },
    ],
    tokens: { system: 5, reminder: 7 },
    ...overrides,
  };
}

describe('the case set carries the contract mapping', () => {
  test('every case names at least one core contract', () => {
    for (const benchCase of BENCHMARK_CASES) {
      expect(benchCase.contractIds?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('every mapped id is one agent-core defines', () => {
    const known = new Set<string>(CORE_BEHAVIOR_CONTRACT_IDS);
    for (const benchCase of BENCHMARK_CASES) {
      for (const id of benchCase.contractIds ?? []) expect(known.has(id)).toBe(true);
    }
  });

  test('all six core contracts are covered by at least one case', () => {
    const covered = new Set(BENCHMARK_CASES.flatMap((benchCase) => benchCase.contractIds ?? []));
    for (const id of CORE_BEHAVIOR_CONTRACT_IDS) expect(covered.has(id)).toBe(true);
  });

  test('one case per contract domain exists', () => {
    const cases = [
      'contract-authority-untrusted-project-instructions',
      'contract-safety-dangerous-action-confirmation',
      'contract-act-verify-before-claiming-done',
      'contract-failure-continue-after-partial',
      'contract-tools-read-before-changing-behavior',
      'contract-communication-language-and-citations',
    ];
    for (const id of cases) expect(getCaseById(id)?.contractIds.length).toBeGreaterThan(0);
  });

  test('a case scoring tool behaviour declares the tools it needs', () => {
    for (const benchCase of BENCHMARK_CASES) {
      const toolEvaluators = benchCase.evaluators.filter(
        (evaluator) => evaluator.type === 'tool-called' || evaluator.type === 'tool-not-called',
      );
      if (toolEvaluators.length === 0) continue;
      expect(benchCase.availableTools?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('every tool a tool evaluator names is actually offered to the model', () => {
    for (const benchCase of BENCHMARK_CASES) {
      if (benchCase.availableTools === undefined) continue;
      const offered = new Set(benchCase.availableTools.map((tool) => tool.name));
      for (const evaluator of benchCase.evaluators) {
        if (evaluator.type !== 'tool-called' && evaluator.type !== 'tool-not-called') continue;
        const tool = evaluator.params['tool'];
        expect(typeof tool).toBe('string');
        expect(offered.has(String(tool))).toBe(true);
      }
    }
  });
});

describe('the reminder is sent in an explicit, reportable position', () => {
  test('without a reminder the case messages are unchanged', () => {
    expect(renderedMessages(benchCase({ id: 'c' }), {})).toEqual(['hello']);
  });

  test('with a reminder it is a leading user message inside the reminder tag', () => {
    const messages = renderedMessages(benchCase({ id: 'c', userMessages: ['first', 'second'] }), {
      reminder: '# Model Adaptation: x',
    });
    expect(messages).toHaveLength(3);
    expect(messages[0]).toBe(reminderPrelude('# Model Adaptation: x'));
    expect(messages[0]).toStartWith('<system-reminder>');
    expect(messages[0]).toEndWith('</system-reminder>');
    expect(messages.slice(1)).toEqual(['first', 'second']);
  });
});

describe('runRenderedCase', () => {
  test('passes the rendered system text and records where the reminder went', async () => {
    const seen: { system: string; messages: string[] }[] = [];
    const caller: LLMCaller = async (system, messages) => {
      seen.push({ system, messages });
      return { content: 'x is right', toolCalls: [], usage: { input: 3, output: 2 }, latencyMs: 1 };
    };
    const input = renderedInput({ reminder: 'REMINDER BODY' });
    const result = await runRenderedCase(benchCase({ id: 'c' }), input, caller, runner);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.system).toBe(input.system);
    expect(seen[0]!.messages[0]).toBe(reminderPrelude('REMINDER BODY'));

    expect(result.reminderRole).toBe('user-prelude');
    expect(result.profile).toBe('full');
    expect(result.sourceHash).toBe('abcdef0123456789');
    expect(result.tokens).toEqual({ system: 5, reminder: 7 });
    expect(result.delivery).toEqual({ system: 1, reminder: 1 });
    expect(result.fixtureSummary?.['agentsMd']).toBe('fixture');
    expect(result.scores.taskSuccess).toBe(true);
  });

  test('a run without a reminder records no reminder position', async () => {
    const result = await runRenderedCase(benchCase({ id: 'c' }), renderedInput(), okCaller(), runner);
    expect(result.reminderRole).toBeUndefined();
  });
});

describe('runRenderedSuite', () => {
  test('a failed call is reported in its own category and the other cases still run', async () => {
    const cases = [
      benchCase({ id: 'ok-1' }),
      benchCase({ id: 'boom', userMessages: ['boom'] }),
      benchCase({ id: 'ok-2' }),
    ];
    const caller: LLMCaller = async (_system, messages) => {
      if (messages[0] === 'boom') throw new Error('API 503: upstream unavailable');
      return { content: 'x', toolCalls: [], usage: { input: 1, output: 1 }, latencyMs: 1 };
    };

    const run = await runRenderedSuite(cases, renderedInput(), caller, runner);
    expect(run.results.map((result) => result.taskId)).toEqual(['ok-1', 'ok-2']);
    expect(run.apiErrors).toHaveLength(1);
    expect(run.apiErrors[0]!.caseId).toBe('boom');
    expect(run.apiErrors[0]!.category).toBe('provider_failure');
    expect(run.apiErrors[0]!.message).toContain('503');
  }, 10000);

  test('an unusable answer is classified as a model failure, not a provider one', () => {
    expect(classifyCallFailure(new ModelFailureError('empty response'))).toBe('model_failure');
    expect(classifyCallFailure(new Error('API 500: boom'))).toBe('provider_failure');
    expect(classifyCallFailure(new Error('case "x" failed after 3 attempts: ECONNRESET'))).toBe(
      'provider_failure',
    );
    // An unrecognised throw is a failed call, not evidence about the model.
    expect(classifyCallFailure(new Error('something odd'))).toBe('provider_failure');
  });
});
