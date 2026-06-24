import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
  toDisposable,
  type IDisposable,
} from '../../../di';
import { OrderedHookSlot } from '../hooks';
import { IEventBus } from '../eventBus/eventBus';
import { IProfileService } from '../profile/profile';
import type { Tool, ToolInfo, ToolSource } from '../types';
import { IToolRegistry, type ToolRegistrationOptions } from './toolRegistry';

declare module '../types' {
  interface AgentEventMap {
    'tool.list.updated': {
      reason: string;
      tools: readonly ToolInfo[];
    };
  }
}

interface ToolEntry {
  readonly tool: Tool;
  readonly source: ToolSource;
}

export class ToolRegistryService extends Disposable implements IToolRegistry {
  private readonly tools = new Map<string, ToolEntry>();

  readonly hooks = {
    onRegistered: new OrderedHookSlot<{ tool: Tool }>(),
    onUnregistered: new OrderedHookSlot<{ tool: Tool }>(),
  };

  constructor(
    @IEventBus private readonly events: IEventBus,
    @IProfileService private readonly profile: IProfileService,
  ) {
    super();
  }

  register(tool: Tool, options: ToolRegistrationOptions = {}): IDisposable {
    const source = options.source ?? tool.source ?? 'builtin';
    const entry: ToolEntry = { tool: withSource(tool, source), source };
    const previous = this.unregisterTool(tool.name);
    this.tools.set(tool.name, entry);

    void this.hooks.onRegistered.run({ tool: entry.tool });
    this.emitToolListUpdated(
      previous === undefined ? `${source}.registered` : `${source}.replaced`,
    );

    return toDisposable(() => {
      const current = this.tools.get(tool.name);
      if (current !== entry) return;
      this.unregisterTool(tool.name);
      this.emitToolListUpdated(`${source}.unregistered`);
    });
  }

  list(): readonly ToolInfo[] {
    return [...this.tools.values()]
      .map(({ tool, source }) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        source,
        info: tool.info,
        active: this.profile.isToolActive(tool.name),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  resolve(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  private unregisterTool(name: string): ToolEntry | undefined {
    const entry = this.tools.get(name);
    if (entry === undefined) return undefined;
    this.tools.delete(name);
    void this.hooks.onUnregistered.run({ tool: entry.tool });
    return entry;
  }

  private emitToolListUpdated(reason: string): void {
    this.events.emit({
      type: 'tool.list.updated',
      reason,
      tools: this.list(),
    });
  }
}

function withSource(tool: Tool, source: ToolSource): Tool {
  return tool.source === source ? tool : { ...tool, source };
}

registerSingleton(IToolRegistry, new SyncDescriptor(ToolRegistryService, [], true));
