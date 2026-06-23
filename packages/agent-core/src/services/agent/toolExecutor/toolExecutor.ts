import { createDecorator } from '../../../di';

import type { ToolCall, ToolResult } from '../types';

export interface IToolExecutor {
  execute(call: ToolCall): Promise<ToolResult>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IToolExecutor = createDecorator<IToolExecutor>('agentToolExecutorService');
