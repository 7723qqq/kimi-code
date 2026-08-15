import { describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { createEmptySessionStats } from '#/tui/utils/session-stats';
import type { AppState } from '#/tui/types';

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
    contextUsage: 0.11,
    contextTokens: 106_000,
    maxContextTokens: 977_000,
  });

  it('renders the full stats bar followed by context on a wide terminal', () => {
    const out = line2(statsState, 160);
    expect(out).toContain('4 turns · 8 steps');
    expect(out).toContain('LLM 3m6s');
    expect(out).toContain('tools 0.9s');
    expect(out).toContain('first token avg 1.8s');
    expect(out).toContain('107 tok/s');
    expect(out).toContain('cache hit 88%');
    expect(out).toContain('in 172k tok · out 18.3k tok');
    expect(out).toContain('context: 11% (104k/954k)');
  });

  it('drops the least important items as the terminal narrows', () => {
    // 62: tool time, first-token avg, tok/s, LLM time and in/out are dropped;
    // the turn count and the always-kept cache/context readouts survive.
    const mid = line2(statsState, 62);
    expect(mid).toContain('4 turns · 8 steps');
    expect(mid).not.toContain('tools 0.9s');
    expect(mid).not.toContain('LLM 3m6s');
    expect(mid).not.toContain('first token avg');
    expect(mid).not.toContain('107 tok/s');
    expect(mid).not.toContain('in 172k tok');

    // 52: turn/step count goes too; cache hit + context remain.
    const narrow = line2(statsState, 52);
    expect(narrow).not.toContain('4 turns · 8 steps');
    expect(narrow).toContain('cache hit 88%');
    expect(narrow).toContain('context:');

    // 30: even cache+context overflow — the renderer truncates the line but
    // the leading cache hit readout stays visible.
    const tiny = line2(statsState, 30);
    expect(tiny).toContain('cache hit 88%');
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
