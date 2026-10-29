import { describe, expect, it } from 'bun:test';

import {
  accumulateStepCompleted,
  accumulateToolDuration,
  buildSessionStatSegments,
  bumpTurnCount,
  createEmptySessionStats,
  firstTokenAverageMs,
  formatCacheHitRate,
  formatOneDecimal,
  formatStatDuration,
  formatTokenSpeed,
} from '#/tui/utils/session-stats';

function sampleStats(): ReturnType<typeof createEmptySessionStats> {
  const stats = createEmptySessionStats();
  return {
    ...stats,
    turnCount: 4,
    stepCount: 7,
    llmTotalMs: 186_000,
    toolTotalMs: 900,
    firstTokenTotalMs: 3_400,
    firstTokenSampleCount: 2,
    inputTokens: 176_128,
    outputTokens: 18_739,
  };
}

function buildStats(steps: number): ReturnType<typeof createEmptySessionStats> {
  let stats = createEmptySessionStats();
  for (let i = 0; i < steps; i += 1) {
    stats = accumulateStepCompleted(stats, undefined, undefined, 1_000 + ((i * 37) % 4_000));
  }
  return stats;
}

describe('createEmptySessionStats / counters', () => {
  it('starts empty', () => {
    expect(createEmptySessionStats()).toEqual({
      turnCount: 0,
      stepCount: 0,
      llmTotalMs: 0,
      toolTotalMs: 0,
      firstTokenTotalMs: 0,
      firstTokenSampleCount: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('bumpTurnCount returns a new object', () => {
    const stats = createEmptySessionStats();
    const next = bumpTurnCount(stats);
    expect(next.turnCount).toBe(1);
    expect(stats.turnCount).toBe(0);
  });

  it('accumulateToolDuration adds and clamps negatives to zero', () => {
    expect(accumulateToolDuration(sampleStats(), 1_500).toolTotalMs).toBe(2_400);
    expect(accumulateToolDuration(sampleStats(), -50).toolTotalMs).toBe(900);
  });
});

describe('accumulateStepCompleted', () => {
  it('counts the step and folds usage + timing fields', () => {
    const next = accumulateStepCompleted(
      sampleStats(),
      { inputOther: 100, inputCacheRead: 200, inputCacheCreation: 300, output: 40 },
      5_000,
      1_500,
    );
    expect(next.stepCount).toBe(8);
    expect(next.llmTotalMs).toBe(191_000);
    expect(next.inputTokens).toBe(176_728);
    expect(next.outputTokens).toBe(18_779);
    expect(next.firstTokenTotalMs).toBe(4_900);
    expect(next.firstTokenSampleCount).toBe(3);
  });

  it('skips undefined usage/timing without disturbing other counters', () => {
    const next = accumulateStepCompleted(sampleStats(), undefined, undefined, undefined);
    expect(next.stepCount).toBe(8);
    expect(next.llmTotalMs).toBe(186_000);
    expect(next.inputTokens).toBe(176_128);
    expect(next.firstTokenTotalMs).toBe(3_400);
    expect(next.firstTokenSampleCount).toBe(2);
  });

  it('ignores negative or non-finite timing values', () => {
    const next = accumulateStepCompleted(sampleStats(), undefined, -1, Number.NaN);
    expect(next.llmTotalMs).toBe(186_000);
    expect(next.firstTokenTotalMs).toBe(3_400);
    expect(next.firstTokenSampleCount).toBe(2);
  });
});

describe('firstTokenAverageMs', () => {
  it('returns null without samples', () => {
    expect(firstTokenAverageMs(createEmptySessionStats())).toBeNull();
  });

  it('averages the samples', () => {
    expect(firstTokenAverageMs(sampleStats())).toBe(1_700);
  });
});

describe('firstTokenAverageMs — constant-time accumulation', () => {
  it('averages every sample exactly after 10k steps', () => {
    let stats = createEmptySessionStats();
    const samples: number[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const sample = 1_000 + ((i * 37) % 4_000);
      samples.push(sample);
      stats = accumulateStepCompleted(stats, undefined, undefined, sample);
    }
    const reference = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;

    expect(stats.firstTokenSampleCount).toBe(samples.length);
    expect(firstTokenAverageMs(stats)).toBe(reference);
  });

  it('keeps the stats object free of per-sample storage', () => {
    const large = buildStats(10_000);

    expect(large.firstTokenSampleCount).toBe(10_000);
    expect(Object.values(large).filter((value) => Array.isArray(value))).toHaveLength(0);
    expect(Object.keys(large).toSorted()).toEqual(
      Object.keys(createEmptySessionStats()).toSorted(),
    );
  });

  it('does not slow down as the step count grows', () => {
    const small = buildStats(1_000);
    const large = buildStats(10_000);
    const time = (stats: ReturnType<typeof createEmptySessionStats>): number => {
      const started = performance.now();
      for (let i = 0; i < 20_000; i += 1) {
        firstTokenAverageMs(accumulateStepCompleted(stats, undefined, undefined, 1_200));
      }
      return performance.now() - started;
    };

    time(small);
    time(large);
    const smallMs = Math.min(time(small), time(small));
    const largeMs = Math.min(time(large), time(large));

    expect(largeMs).toBeLessThan(smallMs * 3);
  });
});

describe('formatOneDecimal', () => {
  it('keeps one decimal place', () => {
    expect(formatOneDecimal(12.345)).toBe('12.3');
    expect(formatOneDecimal(2.5)).toBe('2.5');
  });

  it('drops a redundant .0', () => {
    expect(formatOneDecimal(107)).toBe('107');
    expect(formatOneDecimal(1)).toBe('1');
  });
});

describe('formatTokenSpeed', () => {
  it('keeps one decimal below 100 tok/s', () => {
    expect(formatTokenSpeed(49.3)).toBe('49.3');
  });

  it('rounds to an integer at and above 100 tok/s', () => {
    expect(formatTokenSpeed(99.96)).toBe('100');
    expect(formatTokenSpeed(4957.1)).toBe('4957');
    expect(formatTokenSpeed(120.4)).toBe('120');
  });

  it('renders non-finite / non-positive input as zero', () => {
    expect(formatTokenSpeed(0)).toBe('0');
    expect(formatTokenSpeed(-3)).toBe('0');
    expect(formatTokenSpeed(Number.NaN)).toBe('0');
  });
});

describe('formatStatDuration', () => {
  it('renders sub-minute values with one decimal', () => {
    expect(formatStatDuration(900)).toBe('0.9s');
    expect(formatStatDuration(1_800)).toBe('1.8s');
    expect(formatStatDuration(1_000)).toBe('1s');
  });

  it('renders minutes as m+s with seconds omitted when zero', () => {
    expect(formatStatDuration(186_000)).toBe('3m6s');
    expect(formatStatDuration(60_000)).toBe('1m');
    expect(formatStatDuration(59_960)).toBe('1m');
  });

  it('renders hours as h+m', () => {
    expect(formatStatDuration(3_720_000)).toBe('1h2m');
  });

  it('clamps non-finite / non-positive input to 0s', () => {
    expect(formatStatDuration(0)).toBe('0s');
    expect(formatStatDuration(-5)).toBe('0s');
    expect(formatStatDuration(Number.NaN)).toBe('0s');
  });
});

describe('formatCacheHitRate', () => {
  it('reads cache reads over reads plus writes when writes are reported', () => {
    expect(formatCacheHitRate(1_792, 99, 0)).toBe('cache hit 95%');
  });

  it('falls back to the share of total input when writes are never reported', () => {
    // DeepSeek's Anthropic-compatible endpoint reports reads but no writes:
    // 200 read / (200 read + 800 plain) = 20%, not a fake 100%.
    expect(formatCacheHitRate(200, 0, 800)).toBe('cache hit 20%');
  });

  it('reads 0% when only uncached input has been sent', () => {
    expect(formatCacheHitRate(0, 0, 800)).toBe('cache hit 0%');
  });

  it('returns null when no input has been seen at all', () => {
    expect(formatCacheHitRate(0, 0, 0)).toBeNull();
  });
});

describe('buildSessionStatSegments', () => {
  const context = 'context: 36% (350k/977k)';

  it('omits the counters and timings until a turn reports numbers', () => {
    const groups = buildSessionStatSegments(createEmptySessionStats(), null, null, null, context);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items[0]!.text).toBe(context);
  });

  it('orders the readings the way the strip reads them', () => {
    const stats = {
      ...sampleStats(),
      firstTokenTotalMs: 1_800,
      firstTokenSampleCount: 1,
      inputTokens: 176_128,
      outputTokens: 18_739,
    };
    const groups = buildSessionStatSegments(stats, 'cache hit 88%', '107 tok/s now', null, context);
    const texts = groups.map((group) => group.items.map((item) => item.text).join(' · '));
    expect(texts).toEqual([
      '4 turns · 7 steps',
      'LLM 3m6s · tools 0.9s',
      'first token avg 1.8s · 107 tok/s now',
      'cache hit 88%',
      'in 172k tok · out 18.3k tok',
      context,
    ]);
  });

  it('keeps the step rate and the session average in one segment', () => {
    const groups = buildSessionStatSegments(
      { ...sampleStats(), firstTokenTotalMs: 0, firstTokenSampleCount: 0 },
      null,
      '107 tok/s now',
      '95 tok/s avg',
      context,
    );
    const rates = groups.find((group) => group.items.some((item) => item.text.includes('tok/s')));
    expect(rates?.items).toHaveLength(1);
    expect(rates?.items[0]?.text).toBe('107 tok/s now · 95 tok/s avg');
  });
});
