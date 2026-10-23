import { describe, expect, test } from 'bun:test';

import { CORE_BEHAVIOR_CONTRACT_IDS } from '../../../packages/agent-core-v2/src/app/agentProfileCatalog/behaviorContract';
import { containsSecretLike, redactSecrets } from '../src/redact';
import {
  ContractCoverageError,
  REPORT_SCHEMA_VERSION,
  buildEvaluationReport,
  formatEvaluationReport,
  reportCompletenessErrors,
  type EvaluationReportInput,
} from '../src/report/report';
import type { ApiErrorRecord, BenchmarkCase, BenchmarkResult } from '../src/types';

const FULL_DELIVERY = CORE_BEHAVIOR_CONTRACT_IDS.map((id) => ({ id, channel: 'system' }));

const MINIMAL_DELIVERY = [
  { id: 'authority_and_untrusted_content', channel: 'system' },
  { id: 'act_and_verify', channel: 'system' },
  { id: 'tools_and_repository_context', channel: 'reminder' },
  { id: 'safety_and_scope', channel: 'reminder' },
  { id: 'failure_and_partial_progress', channel: 'reminder' },
  { id: 'communication', channel: 'reminder' },
];

function benchCase(id: string, contractIds: readonly string[] = ['act_and_verify']): BenchmarkCase {
  return {
    id,
    description: id,
    category: 'rule-compliance',
    userMessages: ['do it'],
    relevantSections: [],
    evaluators: [],
    contractIds,
  };
}

function resultOf(id: string, overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    taskId: id,
    promptVersion: 'full',
    model: 'test-model',
    scores: {
      taskSuccess: true,
      ruleCompliance: 1,
      tokenEfficiency: 12,
      toolAccuracy: 1,
      outputConciseness: 1,
    },
    violations: [],
    latencyMs: 1,
    tokenUsage: { input: 10, output: 2 },
    tokens: { system: 5, reminder: 7 },
    rawOutput: 'the answer',
    ...overrides,
  };
}

function input(overrides: Partial<EvaluationReportInput> = {}): EvaluationReportInput {
  const cases = [benchCase('case-1'), benchCase('case-2', ['communication'])];
  return {
    model: 'test-model',
    profile: 'full',
    sourceHash: '0123456789abcdef',
    fixtureSummary: { agentsMd: 'fixture', agentsMdChars: 12 },
    contractDelivery: FULL_DELIVERY,
    reminderPresent: false,
    tokens: { system: 100, reminder: 0 },
    cases,
    results: cases.map((entry) => resultOf(entry.id)),
    apiErrors: [],
    dryRun: false,
    credentialsPresent: true,
    warnings: [],
    ...overrides,
  };
}

describe('the report schema', () => {
  test('a completed real run may report an effect', () => {
    const report = buildEvaluationReport(input());
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(report.effectivenessVerdict).toBe('available');
    expect(report.effectivenessBlockers).toEqual([]);
    expect(reportCompletenessErrors(report)).toEqual([]);
    expect(report.cases.map((entry) => entry.id)).toEqual(['case-1', 'case-2']);
    expect(report.totals).toEqual({ systemTokens: 100, reminderTokens: 0 });
  });

  test('every required field is present and typed', () => {
    const report = buildEvaluationReport(input());
    expect(reportCompletenessErrors(JSON.parse(JSON.stringify(report)))).toEqual([]);
  });

  test('a missing field is a completeness error, not a silently shorter report', () => {
    const report = JSON.parse(JSON.stringify(buildEvaluationReport(input())));
    delete report.sourceHash;
    expect(reportCompletenessErrors(report)).toContain('missing field: sourceHash');
  });

  test('a dry-run verdict of "available" is refused by the checker', () => {
    const report = { ...buildEvaluationReport(input({ dryRun: true })), effectivenessVerdict: 'available' };
    expect(reportCompletenessErrors(report)).toContain(
      'a dry run cannot be an available effectiveness verdict',
    );
  });
});

describe('effectiveness is only claimed when something was measured', () => {
  test('a dry run is unavailable and says so', () => {
    const report = buildEvaluationReport(input({ dryRun: true }));
    expect(report.dryRun).toBe(true);
    expect(report.effectivenessVerdict).toBe('unavailable');
    expect(report.effectivenessBlockers.join(' ')).toMatch(/dry-run/);
  });

  test('a dry run keeps no raw output, which would echo the prompt', () => {
    const cases = [benchCase('case-1')];
    const report = buildEvaluationReport(
      input({
        dryRun: true,
        cases,
        results: [resultOf('case-1', { rawOutput: '[DRY RUN] Would respond to: "<system-reminder>' })],
      }),
    );
    expect(report.cases[0]!.rawOutput).toBeUndefined();
  });

  test('missing credentials make the run unavailable', () => {
    const report = buildEvaluationReport(input({ credentialsPresent: false }));
    expect(report.effectivenessVerdict).toBe('unavailable');
    expect(report.effectivenessBlockers.join(' ')).toMatch(/credentials/);
  });

  test('a render warning makes the run unavailable', () => {
    const report = buildEvaluationReport(
      input({
        warnings: [
          { code: 'unresolved_variable', name: 'cwd', message: 'unresolved template variable ${cwd}' },
        ],
      }),
    );
    expect(report.effectivenessVerdict).toBe('unavailable');
    expect(report.effectivenessBlockers.join(' ')).toContain('${cwd}');
  });

  test('a provider failure is recorded as provider_failure and blocks the verdict', () => {
    const apiErrors: ApiErrorRecord[] = [
      { caseId: 'case-2', category: 'provider_failure', message: 'API 503: upstream unavailable' },
    ];
    const report = buildEvaluationReport(
      input({ cases: [benchCase('case-1'), benchCase('case-2')], results: [resultOf('case-1')], apiErrors }),
    );
    expect(report.apiErrors[0]!.category).toBe('provider_failure');
    expect(report.effectivenessVerdict).toBe('unavailable');
    expect(report.effectivenessBlockers.join(' ')).toMatch(/provider failure in case "case-2"/);
    expect(report.cases.map((entry) => entry.id)).toEqual(['case-1']);
  });

  test('a model failure is a separate category from a provider failure', () => {
    const apiErrors: ApiErrorRecord[] = [
      { caseId: 'case-2', category: 'model_failure', message: 'empty response' },
    ];
    const report = buildEvaluationReport(
      input({ cases: [benchCase('case-1'), benchCase('case-2')], results: [resultOf('case-1')], apiErrors }),
    );
    expect(report.apiErrors[0]!.category).toBe('model_failure');
    // The suite was not measured in full, so it is still unavailable — but the
    // reason differs from a provider fault and the report keeps both facts.
    expect(report.effectivenessVerdict).toBe('unavailable');
    expect(report.effectivenessBlockers.join(' ')).toMatch(/1 case\(s\) produced no result/);
    expect(report.effectivenessBlockers.join(' ')).not.toMatch(/provider failure/);
  });
});

describe('the contract completeness gate', () => {
  test('a profile that delivers a core contract through no channel is refused', () => {
    const delivery = FULL_DELIVERY.filter((entry) => entry.id !== 'safety_and_scope');
    expect(() => buildEvaluationReport(input({ contractDelivery: delivery }))).toThrow(
      ContractCoverageError,
    );
    try {
      buildEvaluationReport(input({ contractDelivery: delivery }));
    } catch (error) {
      const gate = error as ContractCoverageError;
      expect(gate.gaps).toEqual(['safety_and_scope']);
      expect(gate.profile).toBe('full');
      expect(gate.message).toContain('safety_and_scope');
      expect(gate.message).toContain('deepseek-adapted');
    }
  });

  test('a reminder channel with no reminder text does not count as delivery', () => {
    expect(() =>
      buildEvaluationReport(input({ contractDelivery: MINIMAL_DELIVERY, reminderPresent: false })),
    ).toThrow(ContractCoverageError);
  });

  test('the same delivery is complete once the reminder is part of the run', () => {
    const report = buildEvaluationReport(
      input({ contractDelivery: MINIMAL_DELIVERY, reminderPresent: true, profile: 'deepseek-adapted' }),
    );
    expect(report.contractCoverage['safety_and_scope']).toEqual({
      system: 0,
      reminder: 1,
      omitted: 0,
    });
    expect(report.effectivenessVerdict).toBe('available');
  });
});

describe('nothing secret reaches a report', () => {
  const rawOutput =
    'Here is your key: sk-live-abcdef123456 and Authorization: Bearer eyJhbGciOi.abc.def ' +
    'and api_key=supersecretvalue123';

  test('the reported raw output carries no credential material', () => {
    const report = buildEvaluationReport(
      input({ cases: [benchCase('case-1')], results: [resultOf('case-1', { rawOutput })] }),
    );
    const json = JSON.stringify(report);
    const raw = report.cases[0]!.rawOutput ?? '';
    expect(raw).not.toContain('sk-live-abcdef123456');
    expect(raw).not.toContain('supersecretvalue123');
    expect(raw).not.toMatch(/Bearer\s+eyJ/);
    expect(containsSecretLike(json)).toBe(false);
    expect(json).not.toContain('eyJhbGciOi');
  });

  test('an api error message is redacted on the way into the report', () => {
    const report = buildEvaluationReport(
      input({
        cases: [benchCase('case-1')],
        results: [],
        apiErrors: [
          {
            caseId: 'case-1',
            category: 'provider_failure',
            message: redactSecrets('upstream said: x-api-key=abcd1234efgh and sk-live-abcdef123456'),
          },
        ],
      }),
    );
    const json = JSON.stringify(report);
    expect(json).not.toContain('abcd1234efgh');
    expect(json).not.toContain('sk-live-abcdef123456');
    expect(containsSecretLike(json)).toBe(false);
  });

  test('the console rendering mentions no credential either', () => {
    const report = buildEvaluationReport(
      input({ cases: [benchCase('case-1')], results: [resultOf('case-1', { rawOutput })] }),
    );
    const text = formatEvaluationReport(report);
    expect(text).toContain('Effectiveness: available');
    expect(text).toContain('Contract coverage (6/6 core ids)');
    expect(containsSecretLike(text)).toBe(false);
    expect(text).not.toContain('supersecretvalue123');
  });

  test('a long answer is truncated rather than stored whole', () => {
    const report = buildEvaluationReport(
      input({
        cases: [benchCase('case-1')],
        results: [resultOf('case-1', { rawOutput: 'y'.repeat(5000) })],
      }),
    );
    const raw = report.cases[0]!.rawOutput ?? '';
    expect(raw.length).toBeLessThan(2500);
    expect(raw).toContain('[truncated');
  });
});
