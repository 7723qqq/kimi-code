import { createDecorator } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { ExecutableTool, ToolDisclosure, ToolInfo, ToolSource } from '#/tool/toolContract';

export interface ToolRegistrationOptions {
  readonly source?: ToolSource;
  readonly disclosure?: ToolDisclosure;
}

export interface ToolReference {
  readonly name: string;
  readonly source: ToolSource;
}

export interface ToolRegistration extends IDisposable {
  readonly status?: 'active' | 'pending';
}

export type ToolRegistryChange =
  | { readonly type: 'registered'; readonly tool: ExecutableTool }
  | { readonly type: 'unregistered'; readonly tool: ExecutableTool };

export interface IAgentToolRegistryService {
  readonly _serviceBrand: undefined;

  readonly revision: number;
  readonly onDidChange: Event<ToolRegistryChange>;

  register(tool: ExecutableTool, options?: ToolRegistrationOptions): ToolRegistration;
  list(): readonly ToolInfo[];
  listLive?(): readonly ToolInfo[];
  listReferences(): readonly ToolReference[];
  resolve(name: string): ExecutableTool | undefined;
}

export const IAgentToolRegistryService = createDecorator<IAgentToolRegistryService>(
  'agentToolRegistryService',
);
