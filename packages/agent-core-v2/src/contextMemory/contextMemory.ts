import { createDecorator } from "#/_base/di";

import type { Hooks } from '#/hooks';
import type { ContextMessage } from './types';

export interface IContextMemory {
  readonly _serviceBrand: undefined;
  get(): readonly ContextMessage[];
  splice(
    start: number,
    deleteCount: number,
    messages: readonly ContextMessage[],
    tokens?: number,
  ): void;

  readonly hooks: Hooks<{
    onSpliced: {
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
      tokens?: number;
    };
  }>;
}

export const IContextMemory = createDecorator<IContextMemory>('agentContextMemoryService');
