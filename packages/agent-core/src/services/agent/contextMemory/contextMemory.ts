import { createDecorator } from '../../../di';

import type { Hooks } from '../hooks';
import type { ContextMessage } from '../types';

export interface IContextMemory {
  getHistory(): readonly ContextMessage[];
  spliceHistory(start: number, deleteCount: number, ...messages: ContextMessage[]): void;

  readonly hooks: Hooks<{
    onSpliced: { start: number; deleteCount: number; messages: ContextMessage[] };
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IContextMemory = createDecorator<IContextMemory>('agentContextMemoryService');
