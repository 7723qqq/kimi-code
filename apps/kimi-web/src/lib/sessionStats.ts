// Live session statistics — folds raw agent-core frames into display
// totals, mirroring deepseek-harness ui-conversation's StatsLine (MIT):
// turn/step counts, LLM wall time, tool wall time, average first-token
// latency, decode throughput, cache-hit share, and billed tokens.
//
// Live-only by design: the accumulator is fed from the WS stream and resets
// with the session projector (resync / reconnect). Token totals can be
// seeded from the session snapshot's usage for full-history figures; the
// timing figures are always "since subscribe".
//
// Pure module — no scoped state, no DOM. Frames the accumulator reacts to:
//   turn.started / turn.step.started / turn.step.completed /
//   turn.step.interrupted / tool.call.started / tool.result
// Other frame types fall through unchanged (same reference, so a reactive
// wrapper does not dirty on every streaming delta).

/** Display-facing session statistics. */
export interface SessionStats {
  /** User turns seen since subscribe. */
  readonly turns: number;
  /** LLM steps (attempts) seen since subscribe. */
  readonly steps: number;
  /** Summed LLM wall time (request build + first token + stream), ms. */
  readonly llmMs: number;
  /** Summed tool wall time (call started → result), ms. */
  readonly toolMs: number;
  /** Summed first-token latency over the steps that recorded one, ms. */
  readonly ttftMs: number;
  /** Steps that recorded a first-token latency. */
  readonly ttftSteps: number;
  /** Summed decode wall time over steps that also report output tokens, ms. */
  readonly decodeMs: number;
  /** Summed output tokens over the same decode-timed steps. */
  readonly decodeTokens: number;
  /** Live-accumulated input tokens (uncached + cache read + cache write). */
  readonly inputTokens: number;
  /** Live-accumulated output tokens. */
  readonly outputTokens: number;
  /** Live-accumulated cache-read tokens. */
  readonly cacheReadTokens: number;
  /** Live-accumulated cache-creation tokens. */
  readonly cacheCreationTokens: number;
}

export const EMPTY_SESSION_STATS: SessionStats = {
  turns: 0,
  steps: 0,
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftSteps: 0,
  decodeMs: 0,
  decodeTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** One raw WS frame as the accumulator consumes it. */
export interface SessionStatsFrame {
  readonly type: string;
  readonly session_id: string;
  readonly timestamp: string;
  readonly payload: Record<string, unknown> | null;
}

/** Accumulator state: the display stats plus per-call start bookkeeping. */
export interface SessionStatsState {
  readonly stats: SessionStats;
  /** toolCallId → epoch ms of the tool.call.started frame timestamp. */
  readonly toolStartByCallId: Record<string, number>;
}

export function createSessionStatsState(): SessionStatsState {
  return { stats: EMPTY_SESSION_STATS, toolStartByCallId: {} };
}

/** Normalise the raw token usage shape emitted by agent-core. */
export function normalizeUsage(raw: unknown): {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
} {
  const usage = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const inputOther = num(usage['inputOther']);
  const output = num(usage['output']);
  const cacheRead = num(usage['inputCacheRead']);
  const cacheCreate = num(usage['inputCacheCreation']);
  return { input: inputOther + cacheRead + cacheCreate, output, cacheRead, cacheCreate };
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Subagent / side-channel frames (payload.agentId set and not 'main') are not counted. */
function isMainAgent(payload: Record<string, unknown> | null): boolean {
  const agentId = payload?.['agentId'];
  return typeof agentId !== 'string' || agentId === 'main';
}

function parseFrameTime(timestamp: string): number | null {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Feed one raw frame into the accumulator. Returns the SAME state reference
 * when nothing changed (streaming deltas fall through cheaply); a new state
 * object otherwise.
 */
export function feedSessionStats(
  state: SessionStatsState,
  frame: SessionStatsFrame,
): SessionStatsState {
  const payload = frame.payload;
  if (!isMainAgent(payload)) return state;

  const stats = state.stats;
  switch (frame.type) {
    case 'turn.started': {
      return { ...state, stats: { ...stats, turns: stats.turns + 1 } };
    }
    case 'turn.step.started': {
      // Counted when the step CLOSES (completed/interrupted), mirroring the
      // upstream sessionStats projection counting at step/end — counting at
      // start would double-count interrupted attempts.
      return state;
    }
    case 'turn.step.interrupted': {
      return { ...state, stats: { ...stats, steps: stats.steps + 1 } };
    }
    case 'turn.step.completed': {
      const build = numOrNull(payload?.['llmRequestBuildMs']) ?? 0;
      const ttft = numOrNull(payload?.['llmFirstTokenLatencyMs']);
      const stream = numOrNull(payload?.['llmStreamDurationMs']);
      const usage = normalizeUsage(payload?.['usage']);
      const llmMs = stats.llmMs + build + (ttft ?? 0) + (stream ?? 0);
      const decode =
        stream !== null && usage.output > 0
          ? { decodeMs: stats.decodeMs + stream, decodeTokens: stats.decodeTokens + usage.output }
          : { decodeMs: stats.decodeMs, decodeTokens: stats.decodeTokens };
      return {
        ...state,
        stats: {
          ...stats,
          steps: stats.steps + 1,
          llmMs,
          ttftMs: ttft !== null ? stats.ttftMs + ttft : stats.ttftMs,
          ttftSteps: ttft !== null ? stats.ttftSteps + 1 : stats.ttftSteps,
          decodeMs: decode.decodeMs,
          decodeTokens: decode.decodeTokens,
          inputTokens: stats.inputTokens + usage.input,
          outputTokens: stats.outputTokens + usage.output,
          cacheReadTokens: stats.cacheReadTokens + usage.cacheRead,
          cacheCreationTokens: stats.cacheCreationTokens + usage.cacheCreate,
        },
      };
    }
    case 'tool.call.started': {
      const callId = payload?.['toolCallId'];
      const startedAt = parseFrameTime(frame.timestamp);
      if (typeof callId !== 'string' || startedAt === null) return state;
      if (state.toolStartByCallId[callId] !== undefined) return state;
      return {
        ...state,
        toolStartByCallId: { ...state.toolStartByCallId, [callId]: startedAt },
      };
    }
    case 'tool.result': {
      const callId = payload?.['toolCallId'];
      const startedAt = state.toolStartByCallId[callId as string];
      const endedAt = parseFrameTime(frame.timestamp);
      if (typeof callId !== 'string' || startedAt === undefined || endedAt === null) {
        return state;
      }
      const nextToolStarts = { ...state.toolStartByCallId };
      delete nextToolStarts[callId];
      return {
        ...state,
        toolStartByCallId: nextToolStarts,
        stats: {
          ...stats,
          toolMs: stats.toolMs + Math.max(0, endedAt - startedAt),
        },
      };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Derived display figures
// ---------------------------------------------------------------------------

/**
 * Cache-hit share, rounded integer percent; null when no cache traffic.
 * Standard formula: cache-read / (cache-read + cache-creation). The billed
 * input total cannot serve as the denominator here — the snapshot usage's
 * inputTokens excludes cache buckets, so dividing cache-read by it can exceed
 * 100% (e.g. "1584%") once the live totals are overlaid from the snapshot.
 */
export function cacheHitPercent(stats: SessionStats): number | null {
  const cacheTraffic = stats.cacheReadTokens + stats.cacheCreationTokens;
  return cacheTraffic === 0 ? null : Math.round((stats.cacheReadTokens / cacheTraffic) * 100);
}

/** Average first-token latency in ms; null when no step recorded one. */
export function averageTtftMs(stats: SessionStats): number | null {
  return stats.ttftSteps === 0 ? null : stats.ttftMs / stats.ttftSteps;
}

/** Decode throughput in tokens/s; null when no decode time was recorded. */
export function tokensPerSecond(stats: SessionStats): number | null {
  return stats.decodeMs === 0 ? null : (stats.decodeTokens / stats.decodeMs) * 1000;
}

/** Compact duration: "45.2s" under a minute, "2m42s" from there on (no zero padding — "58m5s", matching upstream). */
export function formatDurationMs(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/** Compact decimal-base token count (1K = 1000, "517 / 12.2K / 64.6M") — the display convention used by upstream StatsLine. */
export function formatTokensDecimal(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`;
  return `${scaled(n / 1_000_000)}M`;
}

/** Throughput number — one decimal under 10, rounded above; the "tok/s" unit is supplied by the caller's locale string. */
export function formatTokensPerSecond(tps: number): string {
  const rounded = tps < 10 ? Math.round(tps * 10) / 10 : Math.round(tps);
  return String(rounded);
}
