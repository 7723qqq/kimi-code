import { createDecorator } from '#/_base/di/instantiation';
import type { LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import type { ToolCallStartedPayload } from '#/agent/toolExecutor/toolExecutor';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import type { ContentPart, Message, TextPart, ThinkPart, ToolCall } from '#/kosong/contract/message';
import type { FinishReason } from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

/**
 * External turn-engine override contract.
 *
 * A `TurnEngine` replaces the entire JS turn loop for one turn: it drives
 * the LLM calls and tool executions itself (multi-step), and reports
 * transcript events back through the host-provided callbacks so the
 * session's context memory and UI stay consistent with the JS path.
 *
 * The loop injects `IEngineOverrideService` and asks `getEngine()` at the
 * start of a turn. The default provider returns `undefined` (JS loop runs).
 * The CLI/SDK installs a real provider when `agent.engine = "rust"` selects
 * the kimi-agent Rust engine.
 */
export interface TurnEngineLLMChatInput {
  readonly messages: readonly Message[];
  readonly tools: readonly Tool[];
  readonly signal?: AbortSignal;
  readonly modelName?: string;
  readonly onTextPart?: (part: TextPart) => void | Promise<void>;
  readonly onThinkPart?: (part: ThinkPart) => void | Promise<void>;
}

export interface TurnEngineLLMChatResult {
  readonly toolCalls: ToolCall[];
  readonly providerFinishReason?: string;
  readonly usage: TokenUsage;
}

export interface TurnEngineLLM {
  readonly modelAlias: string;
  readonly modelId: string;
  readonly systemPrompt: string;
  chat(input: TurnEngineLLMChatInput): Promise<TurnEngineLLMChatResult>;
}

export interface TurnEngineExecuteToolOptions {
  readonly signal: AbortSignal;
  readonly turnId: number;
  readonly trace?: LLMRequestTrace;
  readonly step?: number;
  readonly stepUuid?: string;
  readonly onToolCall?: (payload: ToolCallStartedPayload) => void;
}

export interface TurnEngineToolResult {
  readonly output: string | readonly ContentPart[];
  readonly isError?: boolean;
  readonly note?: string;
  readonly stopTurn?: boolean;
}

export interface AskQuestionWireOption {
  readonly label: string;
  readonly description?: string;
}

export interface AskQuestionWireItem {
  readonly question: string;
  readonly header?: string;
  readonly options: readonly AskQuestionWireOption[];
  readonly multi_select: boolean;
}

export interface AskQuestionWire {
  readonly question_id: string;
  readonly turn_id: string;
  readonly tool_call_id: string;
  readonly background: boolean;
  readonly timeout_ms: number | null;
  readonly questions: readonly AskQuestionWireItem[];
}

export interface AskQuestionWireResult {
  readonly answers?: Record<string, string>;
  readonly method?: 'enter' | 'space' | 'number_key';
  readonly note?: string;
  readonly cancelled?: boolean;
  readonly reason?: string;
}

export interface StateReadWire {
  readonly domain: string;
  readonly key: string;
  readonly turn_id?: string;
  readonly tool_call_id?: string;
}

export interface StateReadWireResult {
  readonly value: unknown;
}

export interface StateWriteWire {
  readonly domain: string;
  readonly key: string;
  readonly value: unknown;
  readonly undoable: boolean;
  readonly turn_id?: string;
  readonly tool_call_id?: string;
}

export interface StateWriteWireResult {
  readonly ok: boolean;
  readonly value: unknown;
}

/**
 * Goal snapshot handed to an external engine for budget-aware turns.
 * Mirrors the Rust `GoalContext` wire shape (snake_case) so the engine
 * can check budgets and render steering without an extra round-trip.
 */
export interface TurnEngineGoalContext {
  readonly goalId: string;
  readonly objective: string;
  readonly status: 'active' | 'paused' | 'blocked' | 'complete' | 'budgetLimited' | 'usageLimited';
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
  readonly wallClockMs: number;
  readonly tokensUsed: number;
  readonly turnsUsed: number;
}

/**
 * Engine-owned turn lifecycle record (M1d 3c). Mirrors the Rust
 * `TurnEvent` wire shape (host/turn_event): the durable `turn.prompt` /
 * `turn.cancel` / `turn.ended` records plus the observable `turn.started`.
 * When the engine owns the lifecycle the loop folds these instead of
 * emitting its own; `input` / `origin` are echoed back verbatim from the
 * prompt the host sent (the host maps them to its own types).
 */
export type TurnLifecycleEvent =
  | {
      type: 'turn.prompt';
      turnId: number;
      input: unknown;
      origin: unknown;
    }
  | {
      type: 'turn.started';
      turnId: number;
      origin: unknown;
    }
  | {
      type: 'turn.cancel';
      turnId?: number;
      target?: 'active' | 'queued';
      reason?: 'user_cancelled' | 'aborted';
    }
  | {
      type: 'turn.ended';
      turnId: number;
      reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
      error?: unknown;
      durationMs?: number;
    };

/**
 * Engine-owned turn telemetry (M1d 3c). Mirrors the Rust `TelemetryEvent`
 * wire shape (host/telemetry): the v2 track2 vocabulary plus the merged
 * host context fields. `trace_id` stays a known gap — the engine cannot
 * capture the provider request id yet.
 */
export type TurnTelemetryEvent =
  | {
      event: 'turn_started';
      turn_id: string;
      mode: string;
      provider_type: string;
      protocol: string;
      thinking_effort?: string;
    }
  | {
      event: 'turn_ended';
      turn_id: string;
      mode: string;
      provider_type: string;
      protocol: string;
      thinking_effort?: string;
      reason: 'completed' | 'cancelled' | 'failed';
      duration_ms: number;
      steps?: number;
    }
  | {
      event: 'turn_interrupted';
      turn_id: string;
      mode: string;
      provider_type: string;
      protocol: string;
      thinking_effort?: string;
      at_step?: number;
      interrupt_reason: 'aborted' | 'error';
    }
  /** P54: per-native-execution tool telemetry (v2 `ToolCallEvent`).
   *  `dup_type` is always `normal` — dedupe-supplied repeats never reach
   *  the engine's execution layer. */
  | {
      event: 'tool_call';
      turn_id: number;
      tool_call_id: string;
      tool_name: string;
      outcome: 'success' | 'error' | 'cancelled';
      duration_ms: number;
      dup_type: 'normal' | 'same_step' | 'cross_step';
      error_type?: 'cancelled' | 'error';
    };

export interface TurnEngineInput {
  readonly turnId: number;
  readonly signal: AbortSignal;
  readonly llm: TurnEngineLLM;
  readonly maxSteps?: number;
  /** Context window of the active model (`ModelCapability`); 0 or absent
   *  means unknown, and the engine keeps its own default budget. */
  readonly maxContextTokens?: number;
  buildMessages(): Promise<readonly Message[]>;
  buildTools(): readonly Tool[];
  describeMissingTool?(toolName: string): string | undefined;
  dispatchEvent(event: LoopRecordedEvent): void | Promise<void>;
  executeTool(call: ToolCall, options: TurnEngineExecuteToolOptions): Promise<TurnEngineToolResult>;
  replaceToolResult?(toolCallId: string, result: TurnEngineToolResult): void;
  /** Current goal snapshot, or undefined when no goal exists. Read fresh
   *  each turn so host-side goal changes are reflected. */
  getGoal?(): TurnEngineGoalContext | undefined;
  /**
   * Permission verdict for executing a mutating tool call natively (inside
   * an engine-owned process). The host stays the permission authority: it
   * runs its full machinery (mode, rules, policies, interactive approval)
   * and answers allow or deny. A deny verdict must become the tool result
   * verbatim — never retried through executeTool, which would prompt twice.
   */
  checkToolPermission?(
    call: ToolCall,
  ): Promise<{ decision: 'allow' | 'deny'; reason?: string }>;
  askUserQuestion?(request: AskQuestionWire): Promise<AskQuestionWireResult>;
  stateRead?(request: StateReadWire): Promise<StateReadWireResult>;
  stateWrite?(request: StateWriteWire): Promise<StateWriteWireResult>;
  /**
   * Engine-owned turn lifecycle records (M1d 3c, `host/turn_event`). The
   * engine emits `turn.prompt` / `turn.started` / `turn.cancel` /
   * `turn.ended` as the single writer; the host folds them into the durable
   * log instead of emitting its own. Unwired for engines that do not own the
   * lifecycle.
   */
  onTurnEvent?(event: TurnLifecycleEvent): void;
  /**
   * Engine-owned turn telemetry (M1d 3c, `host/telemetry`). One track2 per
   * event; the host forwards them instead of emitting its own turn
   * telemetry. Unwired for engines that do not own the lifecycle.
   */
  onTurnTelemetry?(event: TurnTelemetryEvent): void;
  /**
   * Session profile catalog snapshot (P46): the profiles the engine's
   * native `Agent` tool may spawn in-process. Profiles absent from the
   * snapshot (plugin sources, anything the host did not push) route back
   * to the host's `Agent` tool. Absent or empty keeps every call
   * host-side.
   */
  subagentProfiles?: readonly TurnEngineSubagentProfile[];
  /** Foreground subagent timeout in ms, resolved host-side (v2
   *  `resolveSubagentTimeoutMs`). Absent: the engine's 2h default. */
  subagentTimeoutMs?: number;
  /**
   * Host-side veto reasons (P52 — the native-path counterpart of the
   * `onBeforeExecuteTool` veto chain, which engine-local execution does
   * not traverse). Non-empty: the engine must reject the affected native
   * execution with the verbatim reason as the tool result (no host
   * round-trip — the host veto would deny it there too).
   *
   * `agentToolVeto` denies the native `Agent` tool only (swarm mode);
   * `toolsVeto` denies every native tool (btw side-channel contexts).
   * Both are per-turn snapshots; a change rebuilds the engine session
   * via the config fingerprint.
   */
  agentToolVeto?: string;
  toolsVeto?: string;
  /**
   * Host-side file checkpoint for native write executions (P53). Called
   * twice per native write: `phase: 'prepare'` before the engine writes —
   * the host must finish capturing the pre-images before the promise
   * resolves — and `phase: 'record'` after (post-image digests, used to
   * detect manual edits at undo). Unwired: the engine skips checkpointing
   * (fail-open, the pre-P53 status quo).
   */
  onCheckpoint?(event: {
    readonly turnId: number;
    readonly phase: 'prepare' | 'record';
    readonly paths: readonly string[];
  }): void | Promise<void>;
  /**
   * Mid-execution output stream from native long-running tools (P57,
   * `tool.progress` mirror): native bash chunks arrive here as they are
   * written so the host can drive live progress cards.
   */
  onToolProgress?(event: {
    readonly turnId: number;
    readonly toolCallId: string;
    readonly update: {
      readonly kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
      readonly text?: string;
      readonly percent?: number;
    };
  }): void;
  /**
   * Subagent lifecycle events from the engine's native `Agent` tool
   * (P51): the mirror of v2's `SubagentSpawned` / `SubagentStarted` /
   * `SubagentCompleted` / `SubagentFailed` surface, so the host
   * dispatcher and UI see native subagents exactly like host-spawned
   * ones. Unwired for engines that emit nothing.
   */
  onSubagentEvent?(event: EngineSubagentEvent): void;
}

/** Engine-native subagent lifecycle event (P51). The adapter maps the
 *  engine's wire payload onto the host's event vocabulary. */
export type EngineSubagentEvent =
  | {
      type: 'subagent.spawned';
      subagentId: string;
      subagentName: string;
      parentToolCallId?: string;
      description?: string;
      runInBackground: boolean;
    }
  | { type: 'subagent.started'; subagentId: string }
  | {
      type: 'subagent.completed';
      subagentId: string;
      resultSummary: string;
      usage?: TokenUsage;
    }
  | { type: 'subagent.failed'; subagentId: string; error: string };

/** A profile from the session catalog snapshot (P46). Mirrors the v2
 *  `AgentProfile` fields an engine needs to run a foreground subagent. */
export interface TurnEngineSubagentProfile {
  readonly name: string;
  readonly description?: string;
  readonly systemPrompt?: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  /** Host-resolved prompt prefix (v2 `applyProfilePromptPrefix`),
   *  prepended engine-side as `{prefix}\n\n{prompt}` (P51). */
  readonly promptPrefix?: string;
  /** Summary distillation policy (v2 `AgentProfileSummaryPolicy`, P51):
   *  the engine re-prompts with the continuation prompt until the final
   *  assistant text clears `minChars` or the retries run out. */
  readonly summaryPolicy?: {
    readonly minChars: number;
    readonly continuationPrompt: string;
    readonly retries: number;
  };
}

export interface TurnEngineResult {
  readonly stopReason: FinishReason;
  readonly steps: number;
  readonly usage: TokenUsage;
  /**
   * Turn telemetry counters aggregated by the engine. Optional so engines
   * without counter support stay contract-compatible.
   */
  readonly telemetry?: TurnEngineTelemetry;
}

/** Counters reported by an external engine for one turn. */
export interface TurnEngineTelemetry {
  /** Host-visible engine events emitted during the turn. */
  readonly eventsEmitted: number;
  /** LLM retries performed during the turn (attempts beyond the first). */
  readonly llmRetries: number;
  /** Which LLM transport served the turn: `native-http` / `host-proxy` / `multi`. */
  readonly llmTransport?: string;
  /** Tool calls the engine executed in its own process rather than on the host. */
  readonly nativeToolCallCount?: number;
}

export type TurnEngine = (input: TurnEngineInput) => Promise<TurnEngineResult>;

export interface EngineOverrideProvider {
  getEngine(): TurnEngine | undefined;
  /**
   * The engine owns the durable turn lifecycle: it emits `turn.prompt` /
   * `turn.started` / `turn.cancel` / `turn.ended` over `onTurnEvent` and
   * its own turn telemetry over `onTurnTelemetry`. When true (and an engine
   * is present), the loop suppresses its own durable turn events and turn
   * telemetry so records are not folded twice.
   */
  ownsTurnLifecycle?: boolean;
  /**
   * Push a mid-turn steer into the engine's own steer queue so the model sees
   * it at the next step head of the running turn. The loop materializes the
   * steer into the context before calling this; the engine-side delivery is
   * best-effort — a failed push leaves the steer to reach the model through
   * the next turn's context projection.
   */
  deliverSteer?(message: Message): Promise<void>;
}

export const IEngineOverrideService = createDecorator<EngineOverrideProvider>(
  'engineOverrideService',
);

export const DEFAULT_ENGINE_OVERRIDE_PROVIDER: EngineOverrideProvider = {
  getEngine: () => undefined,
};
