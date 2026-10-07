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
        llmFirstTokenOffsetMs: 1_000,
        llmLastTokenOffsetMs: 5_800,
        usage: { inputOther: 1_000, output: 400, inputCacheRead: 500, inputCacheCreation: 200 },
      }),
    );
    s = feedSessionStats(
      s,
      stepCompleted({
        llmRequestBuildMs: 50,
        llmFirstTokenLatencyMs: 1_200,
        llmStreamDurationMs: 10_000,
        llmFirstTokenOffsetMs: 20_000,
        llmLastTokenOffsetMs: 29_200,
        usage: { inputOther: 2_000, output: 600, inputCacheRead: 2_000, inputCacheCreation: 300 },
      }),
    );
    expect(s.stats.llmMs).toBe(100 + 800 + 5_000 + 50 + 1_200 + 10_000);
    expect(s.stats.ttftMs).toBe(2_000);
    expect(s.stats.ttftSteps).toBe(2);
    // 4 800 + 9 200, not the 15 000 of llmStreamDurationMs: the decode window
    // is first → last token-bearing part, which brackets the tokens counted.
    expect(s.stats.decodeMs).toBe(14_000);
    // One token fewer than `outputTokens` below: `n` tokens are separated by
    // `n - 1` gaps, and the window spans the gaps. The TUI sampler subtracts
    // the same one, so both readouts agree.
    expect(s.stats.decodeTokens).toBe(998);
    expect(s.stats.inputTokens).toBe(6_000);
    expect(s.stats.outputTokens).toBe(1_000);
    expect(s.stats.cacheReadTokens).toBe(2_500);
    expect(s.stats.cacheCreationTokens).toBe(500);
  });

  it('does not count decode time when the step reports no output tokens', () => {
    let s: SessionStatsState = createSessionStatsState();
    s = feedSessionStats(
      s,
      stepCompleted({
        llmStreamDurationMs: 4_000,
        llmFirstTokenOffsetMs: 1_000,
        llmLastTokenOffsetMs: 5_000,
        usage: { output: 0 },
      }),
    );
    expect(s.stats.decodeMs).toBe(0);
    expect(s.stats.decodeTokens).toBe(0);
  });

  it('skips a step whose decode window is missing, as a pair', () => {
    let s: SessionStatsState = createSessionStatsState();
    // A stream duration but no measured window: the tokens cannot be divided
    // by anything comparable, so neither is counted.
    s = feedSessionStats(
      s,
      stepCompleted({ llmStreamDurationMs: 4_000, usage: { output: 2_000 } }),
    );
    expect(s.stats.decodeMs).toBe(0);
    expect(s.stats.decodeTokens).toBe(0);
    expect(tokensPerSecond(s.stats)).toBeNull();

    // Counted normally once the window is reported.
    s = feedSessionStats(
      s,
      stepCompleted({
        llmFirstTokenOffsetMs: 1_000,
        llmLastTokenOffsetMs: 5_000,
        usage: { output: 2_000 },
      }),
    );
    expect(s.stats.decodeMs).toBe(4_000);
    expect(s.stats.decodeTokens).toBe(1_999);
    // 1 999 tokens over 4 000 ms — the n - 1 numerator, not a 500.0 round.
    expect(tokensPerSecond(s.stats)).toBeCloseTo(499.75, 6);
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
        llmFirstTokenOffsetMs: 1_000,
        llmLastTokenOffsetMs: 5_000,
        usage: { output: 2_000 },
      }),
    );
    expect(averageTtftMs(s.stats)).toBe(600);
    // 2 000 tokens over a 4 000 ms window, less the one gap-less token.
    expect(tokensPerSecond(s.stats)).toBeCloseTo(499.75, 6);
  });

  it('rejects a decode window that is not on the frame clock', () => {
    // A zero-arg frame helper that also marks the endpoints as sharing the
    // frame's clock: the shape the engine emits once it stamps them from its
    // own epoch base. Only a frame carrying that claim is checkable — without
    // it the values are merely offsets and nothing about them can be wrong.
    const clockedStep = (payload: Record<string, unknown>): SessionStatsFrame =>
      stepCompleted({ llmWindowOnFrameClock: true, ...payload });

    // Twenty minutes of uptime: what a reading from another process's monotonic
    // clock looks like when it is read as an epoch. The pair is a plausible 2 s
    // window on its own — nothing in the value gives it away — so only the
    // frame's own arrival can tell that it predates the step it belongs to. A
    // pair like this slipping in unnoticed would add that whole interval to
    // decodeMs and drag the average toward zero.
    let s: SessionStatsState = createSessionStatsState();
    s = feedSessionStats(
      s,
      clockedStep({
        llmStreamDurationMs: 4_000,
        llmFirstTokenOffsetMs: 1_200_000,
        llmLastTokenOffsetMs: 1_202_000,
        usage: { output: 2_000 },
      }),
    );
    expect(s.stats.decodeMs).toBe(0);
    expect(s.stats.decodeTokens).toBe(0);
    expect(tokensPerSecond(s.stats)).toBeNull();

    // The mirror case: an endpoint ahead of the frame that carried it, which is
    // what a clock running a year fast reads as.
    s = feedSessionStats(
      s,
      clockedStep({
        llmStreamDurationMs: 4_000,
        llmFirstTokenOffsetMs: 1_800_000_000_000,
        llmLastTokenOffsetMs: 1_800_000_002_000,
        usage: { output: 2_000 },
      }),
    );
    expect(s.stats.decodeMs).toBe(0);
    expect(s.stats.decodeTokens).toBe(0);
    expect(tokensPerSecond(s.stats)).toBeNull();

    // A step whose window does sit on the frame's clock still counts, so the
    // guard rejects the bad pair and not the readout.
    s = feedSessionStats(
      s,
      clockedStep({
        llmStreamDurationMs: 4_000,
        llmFirstTokenOffsetMs: 1_786_750_000_000,
        llmLastTokenOffsetMs: 1_786_750_004_000,
        usage: { output: 2_000 },
      }),
    );
    expect(s.stats.decodeMs).toBe(4_000);
    expect(tokensPerSecond(s.stats)).toBeCloseTo(499.75, 6);
  });

  it('skips a step that reported a single token', () => {
    // One token has no interval to be decoded over, and the window is measured
    // over gaps: the TUI sampler skips exactly these steps too.
    let s: SessionStatsState = createSessionStatsState();
    s = feedSessionStats(
      s,
      stepCompleted({
        llmFirstTokenOffsetMs: 1_000,
        llmLastTokenOffsetMs: 5_000,
        usage: { output: 1 },
      }),
    );
    expect(s.stats.decodeMs).toBe(0);
    expect(s.stats.decodeTokens).toBe(0);
    expect(tokensPerSecond(s.stats)).toBeNull();
    // The step still counts as a step and its tokens still bill.
    expect(s.stats.steps).toBe(1);
    expect(s.stats.outputTokens).toBe(1);
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
