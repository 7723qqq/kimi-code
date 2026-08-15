import { describe, expect, it } from 'vitest';

import {
  accumulateStepCompleted,
  accumulateToolDuration,
  bumpTurnCount,
  createEmptySessionStats,
  firstTokenAverageMs,
  fitSessionStatsText,
  formatOneDecimal,
  formatStatDuration,
  type SessionStatsGroup,
} from '#/tui/utils/session-stats';

function sampleStats(): ReturnType<typeof createEmptySessionStats> {
  const stats = createEmptySessionStats();
  return {
    ...stats,
    turnCount: 4,
    stepCount: 7,
    llmTotalMs: 186_000,
    toolTotalMs: 900,
    firstTokenSamples: [1_800, 1_600],
    inputTokens: 176_128,
    outputTokens: 18_739,
  };
}

describe('createEmptySessionStats / counters', () => {
  it('starts empty', () => {
    expect(createEmptySessionStats()).toEqual({
      turnCount: 0,
      stepCount: 0,
      llmTotalMs: 0,
      toolTotalMs: 0,
      firstTokenSamples: [],
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
    expect(next.firstTokenSamples).toEqual([1_800, 1_600, 1_500]);
  });

  it('skips undefined usage/timing without disturbing other counters', () => {
    const next = accumulateStepCompleted(sampleStats(), undefined, undefined, undefined);
    expect(next.stepCount).toBe(8);
    expect(next.llmTotalMs).toBe(186_000);
    expect(next.inputTokens).toBe(176_128);
    expect(next.firstTokenSamples).toEqual([1_800, 1_600]);
  });

  it('ignores negative or non-finite timing values', () => {
    const next = accumulateStepCompleted(sampleStats(), undefined, -1, Number.NaN);
    expect(next.llmTotalMs).toBe(186_000);
    expect(next.firstTokenSamples).toEqual([1_800, 1_600]);
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

describe('fitSessionStatsText', () => {
  function groups(): SessionStatsGroup[] {
    return [
      { items: [{ text: 'A', priority: 6 }] },
      {
        items: [
          { text: 'B', priority: 4 },
          { text: 'C', priority: 1 },
        ],
      },
      {
        items: [
          { text: 'D', priority: 2 },
          { text: 'E', priority: 3 },
        ],
      },
      { items: [{ text: 'KEEP1', priority: Number.POSITIVE_INFINITY }] },
      { items: [{ text: 'F', priority: 5 }] },
      { items: [{ text: 'KEEP2', priority: Number.POSITIVE_INFINITY }] },
    ];
  }

  it('joins groups with " | " and items within a group with " · "', () => {
    expect(fitSessionStatsText(groups(), 100)).toBe('A | B · C | D · E | KEEP1 | F | KEEP2');
  });

  it('drops the lowest-priority item first, keeping its group-mates joined', () => {
    // C (priority 1) goes first: B survives alone in its group.
    expect(fitSessionStatsText(groups(), 34)).toBe('A | B | D · E | KEEP1 | F | KEEP2');
    // Then D (priority 2): E stays.
    expect(fitSessionStatsText(groups(), 30)).toBe('A | B | E | KEEP1 | F | KEEP2');
  });

  it('keeps Infinity items until the end and then stops dropping', () => {
    const tight = fitSessionStatsText(groups(), 16);
    expect(tight).toBe('KEEP1 | KEEP2');
    // Infinity-only text that still overflows is returned as-is (the caller
    // truncates at the render boundary).
    expect(
      fitSessionStatsText(
        [{ items: [{ text: 'KEEP1 | KEEP2', priority: Number.POSITIVE_INFINITY }] }],
        1,
      ),
    ).toBe('KEEP1 | KEEP2');
  });

  it('returns empty for an empty group list', () => {
    expect(fitSessionStatsText([], 100)).toBe('');
  });
});
