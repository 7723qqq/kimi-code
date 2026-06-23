import { createDecorator, type IDisposable } from '../../../di';

import type { Hooks } from '../hooks';
import type { Tool, ToolInfo, ToolSource } from '../types';

export interface ToolRegistrationOptions {
  readonly source?: ToolSource;
}

export interface IToolRegistry {
  register(tool: Tool, options?: ToolRegistrationOptions): IDisposable;
  list(): readonly ToolInfo[];
  resolve(name: string): Tool | undefined;

  readonly hooks: Hooks<{
    onRegistered: { tool: Tool };
    onUnregistered: { tool: Tool };
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IToolRegistry = createDecorator<IToolRegistry>('agentToolRegistryService');
