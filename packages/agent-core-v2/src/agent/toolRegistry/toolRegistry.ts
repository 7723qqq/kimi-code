/**
 * `toolRegistry` domain — `IAgentToolRegistryService` contract.
 *
 * Per-agent registry of the tools an agent can resolve and run: `register` /
 * `unregister` / `list` / `resolve`, plus `onRegistered` / `onUnregistered`
 * hooks. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import type {
  ExecutableTool,
  ToolDisclosure,
  ToolInfo,
  ToolSource,
} from '#/tool/toolContract';

export interface ToolRegistrationOptions {
  readonly source?: ToolSource;
  readonly disclosure?: ToolDisclosure;
}

export interface ToolReference {
  readonly name: string;
  readonly source: ToolSource;
}

export interface IAgentToolRegistryService {
  readonly _serviceBrand: undefined;

  register(tool: ExecutableTool, options?: ToolRegistrationOptions): IDisposable;
  list(): readonly ToolInfo[];
  /**
   * O(1) lookup of a single tool's info by name — the per-step hot path
   * (tool selection/policy) must not scan the whole sorted `list()` per name.
   */
  resolveInfo(name: string): ToolInfo | undefined;
  listReferences(): readonly ToolReference[];
  resolve(name: string): ExecutableTool | undefined;
}

export const IAgentToolRegistryService = createDecorator<IAgentToolRegistryService>('agentToolRegistryService');
