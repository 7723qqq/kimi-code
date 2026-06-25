import type {
  ContentPart,
  FinishReason,
  Message,
  StreamedMessagePart,
  TokenUsage,
  Tool as KosongTool,
  ToolCall as KosongToolCall,
} from '@moonshot-ai/kosong';

import type { ContextMessage, PromptOrigin } from '../../agent/context';
import type { ExecutableToolContext } from '../../loop';
import type { LLMRequestLogFields } from '../../loop';
import type { ToolInputDisplay } from '../../tools/display';

export type { ContextMessage, PromptOrigin };


export interface LLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly KosongTool[];
  systemPrompt?: string;
  requestLogFields?: LLMRequestLogFields;
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

export type ToolSource = 'builtin' | 'user' | 'mcp';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
  readonly source?: ToolSource;
  readonly info?: Record<string, unknown>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly raw?: KosongToolCall;
}

export type ToolOutput = string | ContentPart[];

export interface ToolResult {
  readonly output: ToolOutput;
  readonly isError?: boolean;
  readonly message?: string;
  readonly description?: string;
  readonly display?: ToolInputDisplay;
  readonly approvalRule?: string;
  readonly stopTurn?: boolean;
  readonly stopBatchAfterThis?: boolean;
}

export interface ToolExecutionContext extends ExecutableToolContext {
  readonly call: ToolCall;
  readonly args: unknown;
}

export interface ToolInfo extends ToolDefinition {
  readonly source: ToolSource;
}
