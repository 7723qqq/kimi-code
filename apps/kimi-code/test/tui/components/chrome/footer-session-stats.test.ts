import { describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import type { AppState } from '#/tui/types';
import { createEmptySessionStats } from '#/tui/utils/session-stats';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp',
    additionalDirs: [],
    sessionId: 'sess_1',
    permissionMode: 'manual',
    planMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    cacheReadTokens: 0,
    cacheMissTokens: 0,
    cacheOtherTokens: 0,
    tokenSpeed: 0,
    sessionStats: createEmptySessionStats(),
    outputTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    stepRetry: null,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: {},
    ...overrides,
  } as AppState;
}

function line2(state: AppState, width: number): string {
  return strip(new FooterComponent(state).render(width).join('\n')).split('\n')[1] ?? '';
}

describe('FooterComponent — session stats line', () => {
  const statsState: AppState = baseState({
    sessionStats: {
      turnCount: 4,
      stepCount: 8,
      llmTotalMs: 186_000,
      toolTotalMs: 900,
      firstTokenSamples: [1_800],
      inputTokens: 176_128,
      outputTokens: 18_739,
    },
    cacheReadTokens: 880,
    cacheMissTokens: 120,
    cacheOtherTokens: 0,
    tokenSpeed: 107,
    tokenSpeedAverage: 95,
    contextUsage: 0.11,
    contextTokens: 106_000,
    maxContextTokens: 977_000,
  });

  it('renders the full stats bar followed by context on a wide terminal', () => {
    const out = line2(statsState, 170);
    expect(out).toContain('4 turns · 8 steps');
    expect(out).toContain('LLM 3m6s');
    expect(out).toContain('tools 0.9s');
    expect(out).toContain('first token avg 1.8s');
    expect(out).toContain('107 tok/s now');
    expect(out).toContain('95 tok/s avg');
    expect(out).toContain('cache hit 88%');
    expect(out).toContain('in 172k tok · out 18.3k tok');
    expect(out).toContain('context: 11% (104k/954k)');
  });

  it('drops the session totals before the rates, and never splits the pair', () => {
    // The rates answer a question only the moment can answer, so they outlive
    // every cumulative reading. Widest first.
    const wide = line2(statsState, 170);
    expect(wide).toContain('4 turns · 8 steps');
    expect(wide).toContain('107 tok/s now');
    expect(wide).toContain('95 tok/s avg');

    // 95: the turn/step counters and the cumulative timings have gone; every
    // reading describing the reply in flight is still there.
    const withTotals = line2(statsState, 95);
    expect(withTotals).not.toContain('turns ·');
    expect(withTotals).not.toContain('LLM 3m6s');
    expect(withTotals).not.toContain('tools 0.9s');
    expect(withTotals).toContain('first token avg 1.8s');
    expect(withTotals).toContain('107 tok/s now');
    expect(withTotals).toContain('95 tok/s avg');

    // 88: first-token latency goes; the rates are the last optional item left.
    const mid = line2(statsState, 88);
    expect(mid).not.toContain('first token avg');
    expect(mid).toContain('107 tok/s now');
    expect(mid).toContain('95 tok/s avg');

    // 70: the rates go as one item. The two figures are read together or not
    // at all — a width that drops one must drop the other, or the survivor
    // reads like the only answer. Pinned at the boundary and below it.
    for (const width of [70, 62]) {
      const narrow = line2(statsState, width);
      expect(narrow).not.toContain('tok/s now');
      expect(narrow).not.toContain('tok/s avg');
      expect(narrow).toContain('cache hit 88%');
      expect(narrow).toContain('context:');
    }
  });

  it('shows one label when only one figure has a reading', () => {
    // The first step of a session has a step rate before it has an average,
    // and an unavailable figure is omitted rather than shown as a zero.
    const stepOnly = line2(baseState({ ...statsState, tokenSpeed: 107, tokenSpeedAverage: 0 }), 88);
    expect(stepOnly).toContain('107 tok/s now');
    expect(stepOnly).not.toContain('tok/s avg');

    const averageOnly = line2(baseState({ ...statsState, tokenSpeed: 0, tokenSpeedAverage: 95 }), 88);
    expect(averageOnly).not.toContain('tok/s now');
    expect(averageOnly).toContain('95 tok/s avg');
  });

  it('falls back to the plain context readout before any session traffic', () => {
    const out = line2(
      baseState({
        contextUsage: 0.43,
        contextTokens: 440_320,
        maxContextTokens: 1_024_000,
      }),
      120,
    );
    expect(out).toContain('context: 43% (430k/1000k)');
    expect(out).not.toContain(' | ');
  });

  it('renders singular turn/step labels for a single turn', () => {
    const out = line2(
      baseState({
        sessionStats: { ...createEmptySessionStats(), turnCount: 1, stepCount: 1 },
        contextUsage: 0.1,
        contextTokens: 102_400,
        maxContextTokens: 1_024_000,
      }),
      120,
    );
    expect(out).toContain('1 turn · 1 step');
  });
});
