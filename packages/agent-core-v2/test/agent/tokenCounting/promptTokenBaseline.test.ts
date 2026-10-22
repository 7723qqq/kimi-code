import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe } from 'bun:test';

import { estimateTokens } from '#/llm-adapter/contract/tokens';

interface BaselineSample {
  readonly category: string;
  readonly text: string;
  readonly rawPromptTokens: number | null;
  readonly promptTokens: number | null;
  readonly expectedEstimate: number | null;
  readonly tolerance: number;
}

interface Baseline {
  readonly endpoint: string;
  readonly model: string;
  readonly measuredAt: string;
  readonly method: string;
  readonly baselinePromptTokens: number;
  readonly samples: readonly BaselineSample[];
}

const baseline = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/promptTokenBaseline.json'), 'utf8'),
) as Baseline;

function deviationRatio(sample: BaselineSample, estimated: number): number {
  const actual = sample.promptTokens ?? 0;
  return actual === 0 ? Number.POSITIVE_INFINITY : Math.abs(estimated - actual) / actual;
}

describe('prompt token baseline provenance', () => {
  it('records where and how the numbers were measured', () => {
    expect(baseline.endpoint.length).toBeGreaterThan(0);
    expect(baseline.model.length).toBeGreaterThan(0);
    expect(baseline.measuredAt.length).toBeGreaterThan(0);
    expect(baseline.method.length).toBeGreaterThan(0);
    expect(baseline.baselinePromptTokens).toBeGreaterThan(0);
  });

  it('covers the three estimator branches', () => {
    expect(baseline.samples.map((sample) => sample.category).sort()).toEqual([
      'ascii-code',
      'cjk-prose',
      'json-args',
    ]);
  });

  it('carries measured prompt tokens instead of placeholders', () => {
    for (const sample of baseline.samples) {
      expect(typeof sample.promptTokens, `缺少端点测量: category=${sample.category}`).toBe(
        'number',
      );
      expect(typeof sample.rawPromptTokens, `缺少端点测量: category=${sample.category}`).toBe(
        'number',
      );
    }
  });

  it('derives the content count consistently with the recorded baseline', () => {
    for (const sample of baseline.samples) {
      expect(sample.promptTokens, `baseline derivation drifted: ${sample.category}`).toBe(
        (sample.rawPromptTokens ?? 0) - baseline.baselinePromptTokens + 1,
      );
    }
  });
});

describe('prompt token baseline accuracy', () => {
  for (const sample of baseline.samples) {
    it(`estimates ${sample.category} exactly as recorded`, () => {
      expect(estimateTokens(sample.text), `category=${sample.category}`).toBe(
        sample.expectedEstimate!,
      );
    });

    it(`keeps ${sample.category} within its recorded deviation`, () => {
      const estimated = estimateTokens(sample.text);
      expect(
        deviationRatio(sample, estimated),
        `category=${sample.category} estimated=${estimated} actual=${String(sample.promptTokens)}`,
      ).toBeLessThanOrEqual(sample.tolerance);
    });
  }
});
