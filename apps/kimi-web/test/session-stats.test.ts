/**
 * Session stats accumulator — folds raw agent-core frames into display
 * totals for the StatsLine strip (ported from deepseek-harness
 * ui-conversation StatsLine). Covers turn/step counting, LLM wall time,
 * tool wall time from frame timestamps, first-token latency, decode
 * throughput, cache-hit share, and billed-token accumulation; subagent
 * (non-main) frames are ignored.
 * Run: pnpm --filter @moonshot-ai/kimi-web exec vitest run test/session-stats.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  averageTtftMs,
  cacheHitPercent,
  createSessionStatsState,
  feedSessionStats,
  formatDurationMs,
  formatTokensDecimal,
  formatTokensPerSecond,
  normalizeUsage,
  tokensPerSecond,
  type SessionStatsFrame,
  type SessionStatsState,
} from '../src/lib/sessionStats';

function frame(
  type: string,
  payload: Record<string, unknown> | null,
  timestamp = '2026-08-15T00:00:00.000Z',
): SessionStatsFrame {
  return { type, session_id: 's1', timestamp, payload };
}

function stepCompleted(payload: Record<string, unknown>): SessionStatsFrame {
  return frame('turn.step.completed', payload);
}

describe('feedSessionStats', () => {
  it('counts turns and steps from main-agent frames', () => {
    let s: SessionStatsState = createSessionStatsState();
    s = feedSessionStats(s, frame('turn.started', {}));
    s = feedSessionStats(s, frame('turn.step.started', {}));
    s = feedSessionStats(s, frame('turn.step.completed', {}));
    s = feedSessionStats(s, frame('turn.step.started', {}));
    s = feedSessionStats(s, frame('turn.step.completed', {}));
    expect(s.stats).toMatchObject({ turns: 1, steps: 2 });
  });

  it('counts interrupted steps as attempts', () => {
    let s: SessionStatsState = createSessionStatsState();
    s = feedSessionStats(s, frame('turn.started', {}));
    s = feedSessionStats(s, frame('turn.step.started', {}));
    s = feedSessionStats(s, frame('turn.step.interrupted', { reason: 'user_cancelled' }));
    expect(s.stats).toMatchObject({ turns: 1, steps: 1 });
  });

  it('ignores subagent (non-main) frames', () => {
    let s: SessionStatsState = createSessionStatsState();
    s = feedSessionStats(s, frame('turn.started', { agentId: 'sub-1' }));
    s = feedSessionStats(
      s,
      frame('turn.step.completed', { agentId: 'sub-1', usage: { output: 5 } }),
    );
    expect(s.stats).toEqual(createSessionStatsState().stats);
  });

  it('accumulates LLM wall time, TTFT, decode throughput, and usage from step completion', () => {
    let s: SessionStatsState = createSessionStatsState();
    s = feedSessionStats(
      s,
      stepCompleted({
        llmRequestBuildMs: 100,
        llmFirstTokenLatencyMs: 800,
        llmStreamDurationMs: 5_000,
        usage: { inputOther: 1_000, output: 400, inputCacheRead: 500, inputCacheCreation: 200 },
      }),
    );
    s = feedSessionStats(
      s,
      stepCompleted({
        llmRequestBuildMs: 50,
        llmFirstTokenLatencyMs: 1_200,
        llmStreamDurationMs: 10_000,
        usage: { inputOther: 2_000, output: 600, inputCacheRead: 2_000, inputCacheCreation: 300 },
      }),
    );
    expect(s.stats.llmMs).toBe(100 + 800 + 5_000 + 50 + 1_200 + 10_000);
    expect(s.stats.ttftMs).toBe(2_000);
    expect(s.stats.ttftSteps).toBe(2);
    expect(s.stats.decodeMs).toBe(15_000);
    expect(s.stats.decodeTokens).toBe(1_000);
    expect(s.stats.inputTokens).toBe(6_000);
    expect(s.stats.outputTokens).toBe(1_000);
    expect(s.stats.cacheReadTokens).toBe(2_500);
    expect(s.stats.cacheCreationTokens).toBe(500);
  });

  it('does not count decode time when the step reports no output tokens', () => {
    let s: SessionStatsState = createSessionStatsState();
    s = feedSessionStats(s, stepCompleted({ llmStreamDurationMs: 4_000, usage: { output: 0 } }));
    expect(s.stats.decodeMs).toBe(0);
    expect(s.stats.decodeTokens).toBe(0);
  });

  it('measures tool wall time between tool.call.started and tool.result frame timestamps', () => {
    let s: SessionStatsState = createSessionStatsState();
    s = feedSessionStats(
      s,
      frame(
        'tool.call.started',
        { toolCallId: 'call-1', toolName: 'Bash' },
        '2026-08-15T00:00:01.000Z',
      ),
    );
    s = feedSessionStats(
      s,
      frame('tool.result', { toolCallId: 'call-1', output: 'ok' }, '2026-08-15T00:00:04.500Z'),
    );
    expect(s.stats.toolMs).toBe(3_500);
  });

  it('drops a tool result without a recorded start', () => {
    let s: SessionStatsState = createSessionStatsState();
    s = feedSessionStats(s, frame('tool.result', { toolCallId: 'orphan', output: 'x' }));
    expect(s.stats.toolMs).toBe(0);
  });

  it('returns the same state reference for unrelated frames', () => {
    const s = createSessionStatsState();
    expect(feedSessionStats(s, frame('assistant.delta', { text: 'x' }))).toBe(s);
  });
});

describe('derived figures', () => {
  it('computes the cache-hit share of billed input', () => {
    const s = createSessionStatsState();
    const fed = feedSessionStats(
      s,
      stepCompleted({ usage: { inputOther: 100, inputCacheRead: 900, inputCacheCreation: 0 } }),
    );
    expect(cacheHitPercent(fed.stats)).toBe(100);
  });

  it('never exceeds 100% when snapshot usage overlays cache-excluded inputTokens', () => {
    // Regression: the snapshot's inputTokens excludes cache buckets, so a
    // session with heavy cache reuse (read 158.4K, other 10K, creation 0)
    // used to render "缓存命中 1584%". The standard formula over cache
    // traffic keeps the figure bounded.
    const stats = {
      ...createSessionStatsState().stats,
      inputTokens: 168_400,
      outputTokens: 1_000,
      cacheReadTokens: 158_400,
      cacheCreationTokens: 0,
    };
    expect(cacheHitPercent(stats)).toBe(100);
  });

  it('divides cache-read by total cache traffic (read + creation)', () => {
    const stats = {
      ...createSessionStatsState().stats,
      inputTokens: 2_000,
      outputTokens: 100,
      cacheReadTokens: 750,
      cacheCreationTokens: 250,
    };
    expect(cacheHitPercent(stats)).toBe(75);
  });

  it('returns null for cache hit when no input was billed', () => {
    expect(cacheHitPercent(createSessionStatsState().stats)).toBeNull();
  });

  it('computes average TTFT and decode throughput', () => {
    let s: SessionStatsState = createSessionStatsState();
    s = feedSessionStats(
      s,
      stepCompleted({
        llmFirstTokenLatencyMs: 600,
        llmStreamDurationMs: 4_000,
        usage: { output: 2_000 },
      }),
    );
    expect(averageTtftMs(s.stats)).toBe(600);
    expect(tokensPerSecond(s.stats)).toBe(500);
  });

  it('formats durations and throughput compactly', () => {
    expect(formatDurationMs(45_200)).toBe('45.2s');
    expect(formatDurationMs(162_000)).toBe('2m42s');
    // No zero padding on the seconds (upstream convention): "58m5s".
    expect(formatDurationMs(3_485_000)).toBe('58m5s');
    expect(formatTokensPerSecond(129.4)).toBe('129');
    expect(formatTokensPerSecond(9.56)).toBe('9.6');
  });

  it('formats token counts on the decimal base like upstream', () => {
    expect(formatTokensDecimal(517)).toBe('517');
    expect(formatTokensDecimal(12_200)).toBe('12.2K');
    expect(formatTokensDecimal(64_600_000)).toBe('64.6M');
    expect(formatTokensDecimal(517_000)).toBe('517K');
  });
});

describe('normalizeUsage', () => {
  it('handles missing or malformed usage', () => {
    expect(normalizeUsage(undefined)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
    });
    expect(normalizeUsage({ inputOther: 10, output: 2 })).toEqual({
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheCreate: 0,
    });
  });
});
