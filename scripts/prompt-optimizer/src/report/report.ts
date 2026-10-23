/**
 * Prompt Optimizer — Report generator.
 *
 * Renders the multi-variant comparison table. The CLI owns writing report
 * files, so this module only formats text.
 */

import { aggregateResults } from '../benchmark/runner';
import { padRight, sign } from '../format';
import { truncateForReport } from '../redact';
import { contractCoverageFor, contractCoverageGaps } from '../rendered-prompt';
import type {
  ApiErrorRecord,
  BenchmarkCase,
  BenchmarkResult,
  ContractCoverageRecord,
  EvaluationReport,
  ReportCaseResult,
} from '../types';

export interface CompareInput {
  name: string;
  results: BenchmarkResult[];
}

/** Bumped when a required field changes meaning, so a stored report stays readable. */
export const REPORT_SCHEMA_VERSION = 1;

/**
 * Generate a comparison report between multiple prompt variants.
 */
export function generateComparisonReport(inputs: CompareInput[]): string {
  const lines: string[] = [
    'Prompt Variant Comparison Report',
    '═'.repeat(90),
    '',
    padRight('Metric', 22) + inputs.map((i) => padRight(i.name, 16)).join(''),
    '─'.repeat(90),
  ];

  const aggregates = inputs.map((i) => ({
    name: i.name,
    agg: aggregateResults(i.results),
  }));

  // Pass rate row
  lines.push(
    padRight('Pass rate', 22) +
      aggregates.map((a) => padRight(`${(a.agg.passRate * 100).toFixed(1)}%`, 16)).join(''),
  );

  // Rule compliance row
  lines.push(
    padRight('Rule compliance', 22) +
      aggregates
        .map((a) => padRight(`${(a.agg.avgRuleCompliance * 100).toFixed(1)}%`, 16))
        .join(''),
  );

  // Tool accuracy row
  lines.push(
    padRight('Tool accuracy', 22) +
      aggregates.map((a) => padRight(`${(a.agg.avgToolAccuracy * 100).toFixed(1)}%`, 16)).join(''),
  );

  // Token efficiency row
  lines.push(
    padRight('Avg tokens', 22) +
      aggregates.map((a) => padRight(a.agg.avgTokenEfficiency.toFixed(0), 16)).join(''),
  );

  // Conciseness row
  lines.push(
    padRight('Conciseness', 22) +
      aggregates.map((a) => padRight(`${(a.agg.avgConciseness * 100).toFixed(1)}%`, 16)).join(''),
  );

  lines.push('─'.repeat(90));

  // Delta vs first (baseline)
  if (aggregates.length > 1) {
    lines.push('');
    lines.push('Delta vs baseline:');
    const base = aggregates[0]!.agg;
    for (let i = 1; i < aggregates.length; i++) {
      const other = aggregates[i]!;
      const dCompliance = ((other.agg.avgRuleCompliance - base.avgRuleCompliance) * 100).toFixed(1);
      const dTool = ((other.agg.avgToolAccuracy - base.avgToolAccuracy) * 100).toFixed(1);
      const dTokens = (other.agg.avgTokenEfficiency - base.avgTokenEfficiency).toFixed(0);
      lines.push(
        `  ${other.name}: compliance ${sign(dCompliance)}%, tool ${sign(dTool)}%, tokens ${sign(dTokens)}`,
      );
    }
  }

  // Top violations across all
  lines.push('');
  lines.push('Top violations (all variants):');
  const allViolations = new Map<string, number>();
  for (const input of inputs) {
    for (const r of input.results) {
      for (const v of r.violations) {
        allViolations.set(v, (allViolations.get(v) ?? 0) + 1);
      }
    }
  }
  const sorted = [...allViolations.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [rule, count] of sorted) {
    lines.push(`  ${count}x  ${rule}`);
  }

  return lines.join('\n');
}

// ─── Evaluation report ──────────────────────────────────────────────────────

export interface EvaluationReportInput {
  readonly model: string;
  readonly profile: string;
  readonly sourceHash: string;
  readonly fixtureSummary: Record<string, unknown>;
  readonly contractDelivery: readonly { readonly id: string; readonly channel: string }[];
  /** Whether the reminder text was part of this run, so its contracts are covered. */
  readonly reminderPresent: boolean;
  readonly tokens: { readonly system: number; readonly reminder: number };
  readonly cases: readonly BenchmarkCase[];
  readonly results: readonly BenchmarkResult[];
  readonly apiErrors: readonly ApiErrorRecord[];
  readonly dryRun: boolean;
  readonly credentialsPresent: boolean;
  readonly warnings?: readonly { readonly code: string; readonly name: string; readonly message: string }[];
  /** Raw output is kept by default, truncated and redacted; false drops it. */
  readonly includeRawOutput?: boolean;
}

/**
 * A profile that delivers a core contract through no channel.
 *
 * This is a gate, not a warning: a report from such a run would claim complete
 * contract delivery while a whole rule was absent from what the model received.
 */
export class ContractCoverageError extends Error {
  readonly gaps: readonly string[];
  readonly profile: string;

  constructor(profile: string, gaps: readonly string[]) {
    super(
      `Profile "${profile}" delivers no channel for core contract(s): ${gaps.join(', ')}. ` +
        'A report would claim complete delivery while those rules never reached the model. ' +
        'Use the profile that carries them (--profile deepseek-adapted for a minimal family ' +
        'whose reminder supplies them).',
    );
    this.name = 'ContractCoverageError';
    this.profile = profile;
    this.gaps = gaps;
  }
}

function reportCaseResult(
  benchCase: BenchmarkCase,
  result: BenchmarkResult | undefined,
  includeRawOutput: boolean,
): ReportCaseResult | undefined {
  if (result === undefined) return undefined;
  const raw = result.rawOutput;
  return {
    id: benchCase.id,
    contractIds: benchCase.contractIds ?? [],
    passed: result.scores.taskSuccess,
    scores: result.scores,
    violations: [...result.violations],
    tokens: result.tokens ?? { system: 0, reminder: 0 },
    ...(includeRawOutput && raw !== undefined && raw.length > 0
      ? { rawOutput: truncateForReport(raw) }
      : {}),
  };
}

/**
 * Why this run cannot support an effectiveness claim, if it cannot.
 *
 * Every entry is a reason a reader would otherwise over-read the numbers: the
 * responses did not depend on the prompt, the render was incomplete, no
 * credential was available, a provider fault ended a call, or some case produced
 * no result at all.
 */
function effectivenessBlockers(
  input: EvaluationReportInput,
  coverage: Readonly<Record<string, ContractCoverageRecord>>,
): string[] {
  const blockers: string[] = [];
  if (input.dryRun) {
    blockers.push(
      'dry-run: responses do not depend on the prompt, so these numbers measure nothing about it',
    );
  }
  for (const warning of input.warnings ?? []) {
    blockers.push(`render warning: ${warning.message}`);
  }
  if (!input.credentialsPresent) {
    blockers.push('no provider credentials were available, so no real model call was made');
  }
  const providerFailures = input.apiErrors.filter((entry) => entry.category === 'provider_failure');
  for (const entry of providerFailures) {
    blockers.push(`provider failure in case "${entry.caseId}": ${entry.message}`);
  }
  const scored = new Set(input.results.map((result) => result.taskId));
  const missing = input.cases.filter((benchCase) => !scored.has(benchCase.id)).length;
  if (missing > 0) {
    // Name the model failures here: they are a different fact from a provider
    // fault, and a reader of the blockers must be able to tell the two apart.
    const modelFailures = input.apiErrors
      .filter((entry) => entry.category === 'model_failure')
      .map((entry) => entry.caseId);
    const detail =
      modelFailures.length === 0 ? '' : ` (model failure: ${modelFailures.join(', ')})`;
    blockers.push(
      `${missing} case(s) produced no result, so the suite was not measured in full${detail}`,
    );
  }
  if (input.results.length === 0) {
    blockers.push('no case produced a result');
  }
  if (contractCoverageGaps(coverage).length > 0) {
    blockers.push(`contract coverage gap: ${contractCoverageGaps(coverage).join(', ')}`);
  }
  return blockers;
}

/**
 * Assemble the report for one rendered profile.
 *
 * Throws `ContractCoverageError` rather than returning an incomplete report: a
 * caller that ignores the gate would otherwise publish a claim the run cannot
 * support.
 */
export function buildEvaluationReport(input: EvaluationReportInput): EvaluationReport {
  const coverage = contractCoverageFor(input.contractDelivery, {
    reminderPresent: input.reminderPresent,
  });
  const gaps = contractCoverageGaps(coverage);
  if (gaps.length > 0) throw new ContractCoverageError(input.profile, gaps);

  const byId = new Map(input.results.map((result) => [result.taskId, result]));
  // A dry run answers by echoing the case text, so its answer is a synthetic
  // fragment of the prompt: neither evidence nor safe to persist.
  const keepRawOutput = input.includeRawOutput !== false && !input.dryRun;
  const cases: ReportCaseResult[] = [];
  for (const benchCase of input.cases) {
    const entry = reportCaseResult(benchCase, byId.get(benchCase.id), keepRawOutput);
    if (entry !== undefined) cases.push(entry);
  }

  const blockers = effectivenessBlockers(input, coverage);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    model: input.model,
    profile: input.profile,
    sourceHash: input.sourceHash,
    fixtureSummary: input.fixtureSummary,
    contractCoverage: coverage,
    cases,
    totals: { systemTokens: input.tokens.system, reminderTokens: input.tokens.reminder },
    apiErrors: input.apiErrors.map((entry) => ({
      caseId: entry.caseId,
      category: entry.category,
      message: entry.message,
    })),
    dryRun: input.dryRun,
    effectivenessVerdict: blockers.length === 0 ? 'available' : 'unavailable',
    effectivenessBlockers: blockers,
  };
}

const CORE_CONTRACT_ORDER = [
  'authority_and_untrusted_content',
  'act_and_verify',
  'tools_and_repository_context',
  'safety_and_scope',
  'failure_and_partial_progress',
  'communication',
] as const;

/** Terminal rendering of the JSON report, for the CLI. */
export function formatEvaluationReport(report: EvaluationReport): string {
  const lines: string[] = ['Prompt Evaluation Report', '═'.repeat(78), ''];
  lines.push(`Profile:        ${report.profile}`);
  lines.push(`Model:          ${report.model}`);
  lines.push(`Source hash:    ${report.sourceHash}`);
  lines.push(`Dry run:        ${report.dryRun ? 'yes' : 'no'}`);

  const covered = CORE_CONTRACT_ORDER.filter((id) => {
    const count = report.contractCoverage[id];
    return count !== undefined && count.system + count.reminder > 0;
  }).length;
  lines.push('');
  lines.push(`Contract coverage (${covered}/${CORE_CONTRACT_ORDER.length} core ids):`);
  for (const id of CORE_CONTRACT_ORDER) {
    const count = report.contractCoverage[id] ?? { system: 0, reminder: 0, omitted: 0 };
    lines.push(
      `  ${padRight(id, 34)}system ${count.system}  reminder ${count.reminder}  omitted ${count.omitted}`,
    );
  }

  lines.push('');
  lines.push(
    `Tokens (estimated): system ${report.totals.systemTokens}, reminder ${report.totals.reminderTokens}`,
  );
  const passed = report.cases.filter((entry) => entry.passed).length;
  lines.push(`Cases: ${report.cases.length} scored, ${passed} passed`);

  if (report.apiErrors.length > 0) {
    lines.push('');
    lines.push('API errors:');
    for (const entry of report.apiErrors) {
      lines.push(`  ${entry.category}  ${entry.caseId}: ${entry.message}`);
    }
  }

  lines.push('');
  lines.push(`Effectiveness: ${report.effectivenessVerdict}`);
  if (report.effectivenessVerdict === 'unavailable') {
    lines.push(
      '  This report is not evidence about the prompt. Reasons:',
    );
    for (const blocker of report.effectivenessBlockers) lines.push(`  - ${blocker}`);
  }
  return lines.join('\n');
}

const REQUIRED_REPORT_FIELDS: readonly {
  readonly field: string;
  readonly valid: (value: unknown) => boolean;
}[] = [
  { field: 'schemaVersion', valid: (v) => typeof v === 'number' },
  { field: 'model', valid: (v) => typeof v === 'string' && v.length > 0 },
  { field: 'profile', valid: (v) => typeof v === 'string' && v.length > 0 },
  { field: 'sourceHash', valid: (v) => typeof v === 'string' && v.length > 0 },
  { field: 'fixtureSummary', valid: (v) => typeof v === 'object' && v !== null },
  { field: 'contractCoverage', valid: (v) => typeof v === 'object' && v !== null },
  { field: 'cases', valid: (v) => Array.isArray(v) },
  { field: 'totals', valid: (v) => typeof v === 'object' && v !== null },
  { field: 'apiErrors', valid: (v) => Array.isArray(v) },
  { field: 'dryRun', valid: (v) => typeof v === 'boolean' },
  {
    field: 'effectivenessVerdict',
    valid: (v) => v === 'available' || v === 'unavailable',
  },
  { field: 'effectivenessBlockers', valid: (v) => Array.isArray(v) },
];

/**
 * Field-level completeness check.
 *
 * Separate from the type on purpose: the report is written as JSON and read back
 * by tests and by whoever opens the file, so a missing field has to fail a check
 * rather than a compile.
 */
export function reportCompletenessErrors(report: unknown): string[] {
  if (typeof report !== 'object' || report === null) return ['report is not an object'];
  const record = report as Record<string, unknown>;
  const errors: string[] = [];
  for (const { field, valid } of REQUIRED_REPORT_FIELDS) {
    if (!Object.hasOwn(record, field)) errors.push(`missing field: ${field}`);
    else if (!valid(record[field])) errors.push(`invalid field: ${field}`);
  }
  const verdict = record['effectivenessVerdict'];
  const blockers = record['effectivenessBlockers'];
  if (verdict === 'available' && Array.isArray(blockers) && blockers.length > 0) {
    errors.push('effectivenessVerdict is "available" while blockers are listed');
  }
  if (record['dryRun'] === true && verdict === 'available') {
    errors.push('a dry run cannot be an available effectiveness verdict');
  }
  return errors;
}



// ─── Helpers ────────────────────────────────────────────────────────────────


