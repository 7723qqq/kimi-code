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

export interface TurnEngineInput {
  readonly turnId: number;
  readonly signal: AbortSignal;
  readonly llm: TurnEngineLLM;
  readonly maxSteps?: number;
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
  /**
   * Apply the host's result policy — truncation and spill-to-disk — to a tool
   * result the engine produced inside its own process, before it re-enters the
   * model context. Without it a large native result reaches the model raw while
   * the same call executed on the host would be truncated and spilled. Optional
   * so engines without native execution stay contract-compatible.
   */
  finalizeToolResult?(
    toolName: string,
    toolCallId: string,
    result: TurnEngineToolResult,
  ): Promise<TurnEngineToolResult>;
  askUserQuestion?(request: AskQuestionWire): Promise<AskQuestionWireResult>;
  stateRead?(request: StateReadWire): Promise<StateReadWireResult>;
  stateWrite?(request: StateWriteWire): Promise<StateWriteWireResult>;
  /**
   * Drain the host's mid-turn steer queue. The JS loop drains steered prompts
   * at the next step head; an engine driving the whole turn has to ask, or a
   * steered prompt waits for the turn to end. Returns the drained messages in
   * arrival order.
   */
  drainSteers?(): Promise<readonly Message[]>;
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
}

export const IEngineOverrideService = createDecorator<EngineOverrideProvider>(
  'engineOverrideService',
);

export const DEFAULT_ENGINE_OVERRIDE_PROVIDER: EngineOverrideProvider = {
  getEngine: () => undefined,
};
