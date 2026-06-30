import { createDecorator } from "#/_base/di";
import type {
  ToolResult,
  ToolUpdate,
  ToolDidExecuteContext,
  ToolWillExecuteContext,
} from '#/tool';
import type { ToolCall } from '@moonshot-ai/kosong';
import type { LoopEventDispatcher } from '#/loop/events';
import type { OrderedHookSlot } from '#/hooks';

export interface ToolExecutorExecuteOptions {
  readonly signal?: AbortSignal;
  readonly turnId?: string;
  readonly stepNumber?: number;
  readonly stepUuid?: string;
  readonly dispatchEvent?: LoopEventDispatcher | undefined;
  readonly onProgress?: ((toolCallId: string, update: ToolUpdate) => void) | undefined;
}

export interface IAgentToolExecutorService {
  readonly _serviceBrand: undefined;

  execute(calls: ToolCall[], options?: ToolExecutorExecuteOptions): Promise<ToolResult[]>;

  readonly hooks: {
    readonly onWillExecuteTool: OrderedHookSlot<ToolWillExecuteContext>;
    readonly onDidExecuteTool: OrderedHookSlot<ToolDidExecuteContext>;
  };
}

export const IAgentToolExecutorService = createDecorator<IAgentToolExecutorService>('agentToolExecutorService');
