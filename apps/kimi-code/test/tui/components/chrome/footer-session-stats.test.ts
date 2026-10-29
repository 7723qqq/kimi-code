import { describe, expect, it } from 'bun:test';

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
      firstTokenTotalMs: 1_800,
      firstTokenSampleCount: 1,
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

  it('keeps the session totals out of the footer entirely', () => {
    // The totals live in the status strip above the editor now. Rendering them
    // here as well put the same five readings on screen twice, one above the
    // other, and the footer copy is the one that scrolls away with the frame.
    const wide = line2(statsState, 170);
    for (const reading of [
      '4 turns · 8 steps',
      'LLM 3m6s',
      'tools 0.9s',
      'first token avg 1.8s',
      '107 tok/s now',
      '95 tok/s avg',
      'cache hit 88%',
      'in 172k tok · out 18.3k tok',
    ]) {
      expect(wide).not.toContain(reading);
    }
    expect(wide).toContain('context: 11% (104k/954k)');
    expect(wide.trim().startsWith('context:')).toBe(true);
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

  it('hands the context readout over to the strip once it has numbers', () => {
    // The strip carries the context figure as its last group. Rendering it here
    // too would put the same percentage on screen twice, so the footer keeps it
    // only while the strip is still empty.
    const footer = new FooterComponent({
      ...baseState({
        contextUsage: 0.43,
        contextTokens: 440_320,
        maxContextTokens: 1_024_000,
      }),
    });
    let stripHasNumbers = false;
    footer.setStatsShownProbe(() => stripHasNumbers);

    const before = strip(footer.render(120)[1] ?? '');
    expect(before).toContain('context: 43%');

    stripHasNumbers = true;
    const after = strip(footer.render(120)[1] ?? '');
    expect(after).not.toContain('context:');

    // The hint keeps its row: the input box still owns line 2.
    footer.setTransientHint('Press Ctrl-C again to exit');
    const withHint = strip(footer.render(120)[1] ?? '');
    expect(withHint).toContain('Press Ctrl-C again to exit');
    expect(withHint).not.toContain('context:');
  });
});
