import { registerSingleton, SyncDescriptor } from '../../../di';

import type { ToolCall, ToolResult } from '../types';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import { IToolExecutor } from './toolExecutor';

export class ToolExecutorService implements IToolExecutor {
  constructor(@IToolRegistry private readonly tools: IToolRegistry) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.resolve(call.name);
    if (tool === undefined) {
      return {
        output: `Tool "${call.name}" was not found.`,
        isError: true,
      };
    }

    try {
      return await tool.execute(call);
    } catch (error) {
      return {
        output: `Tool "${call.name}" failed: ${errorMessage(error)}`,
        isError: true,
      };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerSingleton(IToolExecutor, new SyncDescriptor(ToolExecutorService, [], true));
