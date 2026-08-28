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
  readonly onTextPart?: (part: TextPart) => void | Promise<void>;
  readonly onThinkPart?: (part: ThinkPart) => void | Promise<void>;
}

export interface TurnEngineLLMChatResult {
  readonly toolCalls: ToolCall[];
  readonly providerFinishReason?: string;
  readonly usage: TokenUsage;
}

export interface TurnEngineLLM {
  readonly modelName: string;
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
}

export interface TurnEngineResult {
  readonly stopReason: FinishReason;
  readonly steps: number;
  readonly usage: TokenUsage;
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
