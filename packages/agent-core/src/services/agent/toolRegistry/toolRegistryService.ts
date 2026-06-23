import { InstantiationType, registerSingleton } from '../../../di';

import { OrderedHookSlot } from '../hooks';
import type { Tool, ToolDefinition } from '../types';
import { IToolRegistry } from './toolRegistry';

export class ToolRegistryService implements IToolRegistry {
  private readonly tools = new Map<string, Tool>();

  readonly hooks = {
    onRegistered: new OrderedHookSlot<{ tool: Tool }>(),
    onUnregistered: new OrderedHookSlot<{ tool: Tool }>(),
  };

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    void this.hooks.onRegistered.run({ tool });
  }

  unregister(name: string): boolean {
    const tool = this.tools.get(name);
    if (tool === undefined) return false;
    this.tools.delete(name);
    void this.hooks.onUnregistered.run({ tool });
    return true;
  }

  list(): readonly ToolDefinition[] {
    return Array.from(this.tools.values()).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  resolve(name: string): Tool | undefined {
    return this.tools.get(name);
  }
}

registerSingleton(IToolRegistry, ToolRegistryService, InstantiationType.Delayed);
