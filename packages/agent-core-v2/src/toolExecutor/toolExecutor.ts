import { createDecorator } from "#/_base/di";
import type { ToolExecution, ToolUpdate } from '#/tool';
import type { ToolCall, ToolResult } from '#/toolRegistry';

export interface ToolExecutorOptions {
  readonly signal?: AbortSignal;
  readonly turnId?: string;
  readonly metadata?: unknown;
  readonly onUpdate?: (update: ToolUpdate) => void;
}

export interface IToolExecutor {
  execute(
    call: ToolCall,
    execution: ToolExecution,
    options?: ToolExecutorOptions,
  ): Promise<ToolResult>;
}

export const IToolExecutor = createDecorator<IToolExecutor>('toolExecutorService');
