import { describe, expect, test } from 'bun:test';

import { getCasesBySection } from '../src/benchmark/cases';
import type { LLMCaller } from '../src/benchmark/runner';
import { runPruner } from '../src/pruner/pruner';
import type { BenchmarkCase, PromptSection } from '../src/types';

const runner = { model: 'test-model', apiBaseUrl: '', apiKey: '', concurrency: 4 };

function section(heading: string, content = `# ${heading}\n\nThe ${heading} rules.`): PromptSection {
  return { heading, content, tokens: 10, startLine: 1, endLine: 2 };
}

const COVERED = 'Coding';
const UNCOVERED = 'Delivering work';

/**
 * A caller whose score depends on the system prompt: it answers well when
 * `marker` is present and badly when it is absent. With `improves = true` the
 * relationship inverts, so removing the section raises the score — the shape
 * the old `Math.min(...)` reported as "no measurable impact".
 */
function markerCaller(marker: string, improves = false): LLMCaller {
  return async (system: string) => {
    const has = system.includes(marker);
    const good = improves ? !has : has;
    return {
      content: good ? '`src/a.ts` Done.' : 'Sure! Would you like an explanation? ' + 'y'.repeat(300),
      toolCalls: [],
      usage: { input: 100, output: good ? 20 : 350 },
      latencyMs: 1,
    };
  };
}

function casesFor(sectionHeading: string): BenchmarkCase[] {
  const relevant = getCasesBySection(sectionHeading);
  if (relevant.length > 0) return relevant;
  return getCasesBySection(COVERED).slice(0, 3);
}

describe('runPruner verdicts', () => {
  test('a section whose removal hurts is kept', async () => {
    const target = section(COVERED);
    const marker = target.content;
    const report = await runPruner([target], casesFor(COVERED), {
      significanceThreshold: 0.1,
      runner,
      caller: markerCaller(marker, true),
    });
    const result = report.sections[0]!;
    expect(result.verdict).toBe('KEEP');
    expect(result.scoreDeltas.ruleCompliance).toBeLessThan(0);
  });

  // Regression guard: this case used to report NONE/"No measurable impact"
  // because Math.min folded the positive delta into the >= -0.02 branch.
  test('a section whose removal HELPS is reported as improving, not as impact-free', async () => {
    const target = section(COVERED);
    const marker = target.content;
    const report = await runPruner([target], casesFor(COVERED), {
      significanceThreshold: 0.1,
      runner,
      caller: markerCaller(marker),
    });
    const result = report.sections[0]!;
    expect(result.impact).toBe('IMPROVES');
    expect(result.verdict).toBe('PRUNE');
    expect(result.reason).toMatch(/improved/i);
    expect(result.reason).not.toMatch(/No measurable impact/);
  });

  test('a section no case covers is UNKNOWN and is not counted as prunable', async () => {
    const covered = section(COVERED);
    const uncovered = section(UNCOVERED);
    expect(getCasesBySection(UNCOVERED)).toHaveLength(0);

    const report = await runPruner([covered, uncovered], casesFor(COVERED), {
      significanceThreshold: 0.1,
      runner,
      caller: markerCaller(covered.content),
    });

    const result = report.sections.find((s) => s.section === UNCOVERED)!;
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.impact).toBe('UNKNOWN');
    expect(result.reason).toMatch(/No benchmark case covers/);
    expect(result.scoreDeltas).toEqual({});

    expect(report.unmeasuredTokens).toBe(uncovered.tokens);
    const prunableHeadings = report.sections
      .filter((s) => s.verdict === 'PRUNE')
      .map((s) => s.section);
    expect(prunableHeadings).not.toContain(UNCOVERED);
  });

  test('the preamble is always kept', async () => {
    const preamble = section('(preamble)', 'You are a coding agent.');
    const report = await runPruner([preamble], casesFor(COVERED), {
      significanceThreshold: 0.1,
      runner,
      caller: markerCaller('nothing-matches'),
    });
    expect(report.sections[0]!.verdict).toBe('KEEP');
    expect(report.sections[0]!.impact).toBe('HIGH');
  });
});
