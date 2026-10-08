/**
 * Prompt Optimizer — Report generator.
 *
 * Renders the multi-variant comparison table. The CLI owns writing report
 * files, so this module only formats text.
 */

import { aggregateResults } from '../benchmark/runner';
import { padRight, sign } from '../format';
import type { BenchmarkResult } from '../types';

export interface CompareInput {
  name: string;
  results: BenchmarkResult[];
}

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


// ─── Helpers ────────────────────────────────────────────────────────────────


