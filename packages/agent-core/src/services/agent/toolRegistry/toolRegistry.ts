import { createDecorator } from '../../../di';

import type { Hooks } from '../hooks';
import type { Tool, ToolDefinition } from '../types';

export interface IToolRegistry {
  register(tool: Tool): void;
  unregister(name: string): boolean;
  list(): readonly ToolDefinition[];
  resolve(name: string): Tool | undefined;

  readonly hooks: Hooks<{
    onRegistered: { tool: Tool };
    onUnregistered: { tool: Tool };
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IToolRegistry = createDecorator<IToolRegistry>('agentToolRegistryService');
