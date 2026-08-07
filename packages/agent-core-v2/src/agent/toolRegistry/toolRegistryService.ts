/**
 * `toolRegistry` domain — `IAgentToolRegistryService` implementation.
 *
 * The per-agent tool table (`tools`) stays a plain instance field: its values
 * hold `ExecutableTool` class instances, not plain data, so it is not
 * registered into `agentState` (`IAgentStateService`). Bound at Agent scope.
 */

import { toDisposable, type IDisposable } from "#/_base/di/lifecycle";
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type {
  ExecutableTool,
  ToolDisclosure,
  ToolInfo,
  ToolSource,
} from '#/tool/toolContract';
import {
  IAgentToolRegistryService,
  type ToolReference,
  type ToolRegistrationOptions,
} from './toolRegistry';

import './builtinToolAssemblyService';

interface ToolEntry {
  readonly tool: ExecutableTool;
  readonly source: ToolSource;
  readonly disclosure?: ToolDisclosure;
}

export class AgentToolRegistryService implements IAgentToolRegistryService {
  declare readonly _serviceBrand: undefined;
  private readonly tools = new Map<string, ToolEntry>();
  /** Sorted `list()` result, invalidated on register/unregister. */
  private listCache: readonly ToolInfo[] | undefined;

  register(tool: ExecutableTool, options: ToolRegistrationOptions = {}): IDisposable {
    const source = options.source ?? 'builtin';
    const entry: ToolEntry = { tool, source, disclosure: options.disclosure };
    this.unregisterTool(tool.name);
    this.tools.set(tool.name, entry);
    this.listCache = undefined;

    return toDisposable(() => {
      const current = this.tools.get(tool.name);
      if (current !== entry) return;
      this.unregisterTool(tool.name);
    });
  }

  list(): readonly ToolInfo[] {
    if (this.listCache !== undefined) return this.listCache;
    this.listCache = [...this.tools.values()]
      .map(({ tool, source, disclosure }) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        source,
        disclosure,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    return this.listCache;
  }

  resolveInfo(name: string): ToolInfo | undefined {
    const entry = this.tools.get(name);
    if (entry === undefined) return undefined;
    return {
      name: entry.tool.name,
      description: entry.tool.description,
      parameters: entry.tool.parameters,
      source: entry.source,
      disclosure: entry.disclosure,
    };
  }

  listReferences(): readonly ToolReference[] {
    return [...this.tools.entries()]
      .map(([name, { source }]) => ({ name, source }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  resolve(name: string): ExecutableTool | undefined {
    return this.tools.get(name)?.tool;
  }

  private unregisterTool(name: string): ToolEntry | undefined {
    const entry = this.tools.get(name);
    if (entry === undefined) return undefined;
    this.tools.delete(name);
    this.listCache = undefined;
    return entry;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolRegistryService,
  AgentToolRegistryService,
  ScopeActivation.OnScopeCreated,
  'toolRegistry',
);
