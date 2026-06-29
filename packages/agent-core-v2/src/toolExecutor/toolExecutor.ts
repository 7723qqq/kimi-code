import { createDecorator } from "#/_base/di";
import type { ToolCall } from '@moonshot-ai/kosong';
import type { ToolUpdate } from '#/tool';
import type { LoopEventDispatcher } from '#/loop/events';
import type { ToolResult } from '#/toolRegistry';
import type { ToolDidExecuteContext, ToolWillExecuteContext } from '#/turn';
import type { OrderedHookSlot } from '#/hooks';

export interface ToolExecutorExecuteOptions {
  readonly signal?: AbortSignal;
  readonly turnId?: string;
  readonly stepNumber?: number;
  readonly stepUuid?: string;
  readonly dispatchEvent?: LoopEventDispatcher | undefined;
  readonly onProgress?: ((toolCallId: string, update: ToolUpdate) => void) | undefined;
}

export interface IToolExecutor {
  readonly _serviceBrand: undefined;

  execute(calls: ToolCall[], options?: ToolExecutorExecuteOptions): Promise<ToolResult[]>;

  readonly hooks: {
    readonly onWillExecuteTool: OrderedHookSlot<ToolWillExecuteContext>;
    readonly onDidExecuteTool: OrderedHookSlot<ToolDidExecuteContext>;
  };
}

export const IToolExecutor = createDecorator<IToolExecutor>('toolExecutorService');
