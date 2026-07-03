import { createDecorator } from '#/_base/di';
import type {
  ToolResult,
  ToolDidExecuteContext,
  ToolWillExecuteContext,
} from '#/agent/tool';
import type { ToolCall } from '#/app/llmProtocol';
import type { OrderedHookSlot } from '#/hooks';

export interface ToolExecutorExecuteOptions {
  readonly signal: AbortSignal;
  readonly turnId: number;
  readonly onToolResult?: (toolCallId: string, result: ToolResult) => void | Promise<void>;
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
