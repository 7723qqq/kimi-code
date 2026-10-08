/**
 * Prompt Optimizer — Pruner.
 *
 * Systematically removes each section from system.md,
 * runs the relevant benchmark cases, and reports impact.
 */

import { getCasesBySection } from '../benchmark/cases';
import { padRight } from '../format';
import { runSuite, aggregateResults, type LLMCaller, type RunnerConfig } from '../benchmark/runner';
import { generateBaselineVariant, generatePruneVariant } from '../prompt-parser';
import type { BenchmarkCase, PromptSection, PruneReport, PruneResult } from '../types';

export interface PrunerConfig {
  /** Minimum score delta to consider "significant" */
  significanceThreshold: number;
  /** Model and API config */
  runner: RunnerConfig;
  /** LLM caller */
  caller: LLMCaller;
}

const DEFAULT_PRUNER_CONFIG: Partial<PrunerConfig> = {
  significanceThreshold: 0.1,
};

/**
 * Run the pruner: for each section, remove it and measure impact.
 */
export async function runPruner(
  sections: PromptSection[],
  allCases: BenchmarkCase[],
  config: PrunerConfig,
): Promise<PruneReport> {
  const threshold = config.significanceThreshold ?? DEFAULT_PRUNER_CONFIG.significanceThreshold!;

  // 1. Run baseline
  const baselineVariant = generateBaselineVariant(sections);
  const baselineResults = await runSuite(allCases, baselineVariant, config.caller, config.runner);

  // 2. For each section, run with that section removed
  const pruneResults: PruneResult[] = [];

  for (const section of sections) {
    // Skip preamble (identity text — always needed)
    if (section.heading === '(preamble)') {
      pruneResults.push({
        section: section.heading,
        tokens: section.tokens,
        impact: 'HIGH',
        verdict: 'KEEP',
        reason: 'Identity preamble — always required',
        scoreDeltas: {},
      });
      continue;
    }

    // Find cases relevant to this section. When none cover it there is nothing
    // to measure: scoring it against unrelated cases tells us about those cases,
    // not this section, so it is reported as UNKNOWN rather than guessed at.
    const relevantCases = getCasesBySection(section.heading);
    if (relevantCases.length === 0) {
      pruneResults.push({
        section: section.heading,
        tokens: section.tokens,
        impact: 'UNKNOWN',
        verdict: 'UNKNOWN',
        reason: 'No benchmark case covers this section',
        scoreDeltas: {},
      });
      continue;
    }

    // Run pruned variant against the same case set
    const prunedVariant = generatePruneVariant(sections, section.heading);
    const prunedResults = await runSuite(
      relevantCases,
      prunedVariant,
      config.caller,
      config.runner,
    );
    const prunedAgg = aggregateResults(prunedResults);

    // Compare against baseline scores on the SAME case subset (not all cases)
    const relevantCaseIds = new Set(relevantCases.map((c) => c.id));
    const relevantBaselineResults = baselineResults.filter((r) => relevantCaseIds.has(r.taskId));
    const relevantBaselineAgg = aggregateResults(relevantBaselineResults);

    const complianceDelta = prunedAgg.avgRuleCompliance - relevantBaselineAgg.avgRuleCompliance;
    const toolDelta = prunedAgg.avgToolAccuracy - relevantBaselineAgg.avgToolAccuracy;
    const passRateDelta = prunedAgg.passRate - relevantBaselineAgg.passRate;

    // The verdict is driven by the worst dimension, but a delta on every
    // dimension that is positive is its own signal: removing the section helped,
    // which the old `min(...)` folded into "no measurable impact".
    const worstDelta = Math.min(complianceDelta, toolDelta, passRateDelta);
    const bestDelta = Math.max(complianceDelta, toolDelta, passRateDelta);

    let impact: PruneResult['impact'];
    let verdict: PruneResult['verdict'];
    let reason: string;

    if (bestDelta >= 0.02 && worstDelta >= 0) {
      impact = 'IMPROVES';
      verdict = 'PRUNE';
      reason = `Removal improved every measured dimension (best ${(bestDelta * 100).toFixed(1)}%)`;
    } else if (worstDelta >= -0.02) {
      impact = 'NONE';
      verdict = 'PRUNE';
      reason = 'No measurable impact when removed';
    } else if (worstDelta >= -threshold) {
      impact = 'LOW';
      verdict = 'PRUNE';
      reason = `Minor impact (${(worstDelta * 100).toFixed(1)}% delta)`;
    } else if (worstDelta >= -threshold * 2) {
      impact = 'MEDIUM';
      verdict = 'KEEP';
      reason = `Moderate impact (${(worstDelta * 100).toFixed(1)}% delta)`;
    } else {
      impact = 'HIGH';
      verdict = 'KEEP';
      reason = `Critical section (${(worstDelta * 100).toFixed(1)}% delta)`;
    }

    pruneResults.push({
      section: section.heading,
      tokens: section.tokens,
      impact,
      verdict,
      reason,
      scoreDeltas: {
        ruleCompliance: complianceDelta,
        toolAccuracy: toolDelta,
      },
    });
  }

  const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
  const prunableTokens = pruneResults
    .filter((r) => r.verdict === 'PRUNE')
    .reduce((sum, r) => sum + r.tokens, 0);
  const unmeasuredTokens = pruneResults
    .filter((r) => r.verdict === 'UNKNOWN')
    .reduce((sum, r) => sum + r.tokens, 0);

  return {
    promptVersion: 'current',
    model: config.runner.model,
    totalTokens,
    prunableTokens,
    sections: pruneResults,
    unmeasuredTokens,
  };
}

/**
 * Format prune report as a readable table.
 */
export function formatPruneReport(report: PruneReport): string {
  const pct = (part: number): string =>
    report.totalTokens > 0 ? ((part / report.totalTokens) * 100).toFixed(1) : '0.0';
  const lines: string[] = [
    'Prompt Health Report',
    '═'.repeat(80),
    `Model: ${report.model} | Total: ${report.totalTokens} tokens | Prunable: ${report.prunableTokens} tokens (${pct(report.prunableTokens)}%)`,
    ...(report.unmeasuredTokens > 0
      ? [
          `Unmeasured: ${report.unmeasuredTokens} tokens (${pct(report.unmeasuredTokens)}%) — no benchmark case covers these sections`,
        ]
      : []),
    '─'.repeat(80),
    padRight('Section', 35) +
      padRight('Tokens', 8) +
      padRight('Impact', 10) +
      padRight('Verdict', 8) +
      'Reason',
    '─'.repeat(80),
  ];

  for (const r of report.sections) {
    lines.push(
      padRight(r.section.slice(0, 33), 35) +
        padRight(String(r.tokens), 8) +
        padRight(r.impact, 10) +
        padRight(r.verdict, 8) +
        r.reason,
    );
  }

  lines.push('─'.repeat(80));
  return lines.join('\n');
}

