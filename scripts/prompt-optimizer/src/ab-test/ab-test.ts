/**
 * Prompt Optimizer — A/B Test Framework.
 *
 * Runs multiple prompt variants against the same case set,
 * compares scores, and outputs a statistical report.
 */

import { BENCHMARK_CASES } from '../benchmark/cases';
import { avg, formatNum, padRight } from '../format';
import {
  estimatePower,
  pairedDifferences,
  pairedPermutationP,
} from './statistics';
import { runSuite, aggregateResults, type LLMCaller, type RunnerConfig } from '../benchmark/runner';
import type {
  ABComparison,
  ABExperiment,
  ABResult,
  BenchmarkCase,
  BenchmarkResult,
  BenchmarkScores,
} from '../types';

export interface ABConfig {
  runner: RunnerConfig;
  caller: LLMCaller;
}

/**
 * Execute an A/B experiment.
 */
export async function runABExperiment(
  experiment: ABExperiment,
  config: ABConfig,
): Promise<ABResult> {
  const cases = resolveCases(experiment.caseFilter);
  const variantResults = new Map<string, BenchmarkResult[]>();

  for (const variant of experiment.variants) {
    const allResults: BenchmarkResult[] = [];

    for (let rep = 0; rep < experiment.repetitions; rep++) {
      const results = await runSuite(cases, variant, config.caller, config.runner);
      allResults.push(...results);
    }

    variantResults.set(variant.name, allResults);
  }

  // Generate pairwise comparisons
  const comparison = generateComparisons(experiment, variantResults);

  return { experiment: experiment.name, variantResults, comparison };
}

/**
 * Generate pairwise comparisons between all variant pairs.
 */
function generateComparisons(
  experiment: ABExperiment,
  variantResults: Map<string, BenchmarkResult[]>,
): ABComparison[] {
  const comparisons: ABComparison[] = [];
  const variants = experiment.variants;
  const dimensions: (keyof BenchmarkScores)[] = [
    'ruleCompliance',
    'tokenEfficiency',
    'toolAccuracy',
    'outputConciseness',
  ];

  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const nameA = variants[i]!.name;
      const nameB = variants[j]!.name;
      const resultsA = variantResults.get(nameA) ?? [];
      const resultsB = variantResults.get(nameB) ?? [];

      for (const dim of dimensions) {
        const scoresA = resultsA.map((r) => getScore(r.scores, dim));
        const scoresB = resultsB.map((r) => getScore(r.scores, dim));

        const meanA = avg(scoresA);
        const meanB = avg(scoresB);
        const delta = meanB - meanA;
        const deltaPercent = meanA !== 0 ? (delta / Math.abs(meanA)) * 100 : 0;

        // Both variants ran the same cases, so compare per case rather than
        // treating the two sets as independent samples.
        const byTask = (results: BenchmarkResult[]): Map<string, number[]> => {
          const map = new Map<string, number[]>();
          for (const r of results) {
            const list = map.get(r.taskId) ?? [];
            list.push(getScore(r.scores, dim));
            map.set(r.taskId, list);
          }
          return map;
        };
        const differences = pairedDifferences({ a: byTask(resultsA), b: byTask(resultsB) });
        const significant = pairedPermutationP(differences) < 0.05;

        let verdict: ABComparison['verdict'];
        if (!significant) verdict = 'tie';
        else if (dim === 'tokenEfficiency')
          verdict = delta < 0 ? 'B wins' : 'A wins'; // lower is better
        else verdict = delta > 0 ? 'B wins' : 'A wins';

        comparisons.push({
          variantA: nameA,
          variantB: nameB,
          dimension: dim,
          meanA,
          meanB,
          delta,
          deltaPercent,
          significant,
          verdict,
          power: estimatePower(scoresB, differences),
        });
      }
    }
  }

  return comparisons;
}

/**
 * Format A/B test results as a readable report.
 */
export function formatABReport(result: ABResult): string {
  const lines: string[] = [`A/B Test Report: ${result.experiment}`, '═'.repeat(80), ''];

  // Summary per variant
  for (const [name, results] of result.variantResults) {
    const agg = aggregateResults(results);
    lines.push(
      `Variant: ${name}`,
      `  Pass rate: ${(agg.passRate * 100).toFixed(1)}%`,
      `  Rule compliance: ${(agg.avgRuleCompliance * 100).toFixed(1)}%`,
      `  Tool accuracy: ${(agg.avgToolAccuracy * 100).toFixed(1)}%`,
      `  Avg tokens: ${agg.avgTokenEfficiency.toFixed(0)}`,
      '',
    );
  }

  // Comparison table
  lines.push('─'.repeat(80));
  lines.push(
    padRight('Dimension', 20) +
      padRight('A mean', 10) +
      padRight('B mean', 10) +
      padRight('Delta', 10) +
      padRight('Sig?', 6) +
      padRight('Verdict', 10) +
      'Detectable',
  );
  lines.push('─'.repeat(80));

  for (const c of result.comparison) {
    lines.push(
      padRight(c.dimension, 20) +
        padRight(formatNum(c.meanA), 10) +
        padRight(formatNum(c.meanB), 10) +
        padRight(`${c.deltaPercent >= 0 ? '+' : ''}${c.deltaPercent.toFixed(1)}%`, 10) +
        padRight(c.significant ? 'YES' : 'no', 6) +
        padRight(c.verdict, 10) +
        `±${c.power.detectableDelta.toFixed(3)} (n=${c.power.n})`,
    );
  }

  lines.push('─'.repeat(80));
  const { n } = result.comparison[0]?.power ?? { n: 0 };
  lines.push(
    '',
    `"Detectable" is the smallest effect this run (n=${n} cases per variant, α=0.05) could`,
    'distinguish from zero. A tie with a large detectable effect means the sample was too',
    'small to see the difference, not that no difference exists.',
  );
  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveCases(filter: string[] | 'all'): BenchmarkCase[] {
  if (filter === 'all') return BENCHMARK_CASES;
  return BENCHMARK_CASES.filter((c) => filter.includes(c.id) || filter.includes(c.category));
}

function getScore(scores: BenchmarkScores, dim: keyof BenchmarkScores): number {
  const val = scores[dim];
  if (typeof val === 'boolean') return val ? 1 : 0;
  return val;
}




