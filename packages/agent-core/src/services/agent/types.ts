import type {
  FinishReason,
  Message,
  StreamedMessagePart,
  TokenUsage,
  Tool as KosongTool,
  ToolCall as KosongToolCall,
} from '@moonshot-ai/kosong';

import type { ContextMessage } from '../../agent/context';

export type { ContextMessage };

export interface AgentEventMap {
  'context.spliced': {
    start: number;
    deleteCount: number;
    messages: ContextMessage[];
  };
}

export type AgentEvent<K extends keyof AgentEventMap = keyof AgentEventMap> = {
  [T in K]: { readonly type: T } & Readonly<AgentEventMap[T]>;
}[K];

export interface WireRecordMap {
  'context.splice': {
    start: number;
    deleteCount: number;
    messages: ContextMessage[];
  };
}

export type WireRecord<K extends keyof WireRecordMap = keyof WireRecordMap> = {
  [T in K]: { readonly type: T } & Readonly<WireRecordMap[T]>;
}[K];

export interface LLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly KosongTool[];
  systemPrompt?: string;
}

export type LLMEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly model?: string }
  | {
      readonly type: 'finish';
      readonly providerFinishReason?: FinishReason;
      readonly rawFinishReason?: string;
    }
  | {
      readonly type: 'timing';
      readonly firstTokenLatencyMs: number;
      readonly streamDurationMs: number;
    };

export interface TurnResult {
  readonly reason: 'completed' | 'cancelled' | 'failed';
  readonly error?: unknown;
}

export interface Turn {
  readonly id: string;
  readonly abortController: AbortController;
  readonly ready: Promise<void>;
  readonly result: Promise<TurnResult>;
}

export interface TurnStepContext {
  readonly turn: Turn;
  continueTurn: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
}

export interface Tool extends ToolDefinition {
  execute(call: ToolCall): Promise<ToolResult> | ToolResult;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly raw?: KosongToolCall;
}

export interface ToolResult {
  readonly output: string;
  readonly isError?: boolean;
}
