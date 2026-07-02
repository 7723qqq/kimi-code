import { createDecorator } from '#/_base/di';
import type {
  ToolResult,
  ToolUpdate,
  ToolDidExecuteContext,
  ToolWillExecuteContext,
} from '#/agent/tool';
import type { AgentEvent } from '@moonshot-ai/protocol';
import type { ToolCall } from '#/app/llmProtocol';
import type { OrderedHookSlot } from '#/hooks';

export interface ToolExecutorExecuteOptions {
  readonly signal: AbortSignal;
  readonly turnId: number;
  readonly onToolResult?: (toolCallId: string, result: ToolResult) => void | Promise<void>;
  readonly dispatchProtocolEvent?: (event: AgentEvent) => void;
  readonly onProgress?: (toolCallId: string, update: ToolUpdate) => void;
}

export interface IAgentToolExecutorService {
  readonly _serviceBrand: undefined;

  execute(calls: ToolCall[], options: ToolExecutorExecuteOptions): Promise<ToolResult[]>;

  readonly hooks: {
    readonly onWillExecuteTool: OrderedHookSlot<ToolWillExecuteContext>;
    readonly onDidExecuteTool: OrderedHookSlot<ToolDidExecuteContext>;
  };
}

export const IAgentToolExecutorService =
  createDecorator<IAgentToolExecutorService>('agentToolExecutorService');
