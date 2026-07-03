/**
 * `agentTool` domain (L5) — `IAgentToolService` implementation.
 *
 * Owns the Agent-scoped hook slots for child-agent start/stop lifecycle events.
 * The actual `Agent` tool is registered by `agentLifecycle` as a builtin tool;
 * this service remains as the observer boundary consumed by `externalHooks`.
 * Bound at Agent scope.
 */

import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { OrderedHookSlot } from '#/hooks';

import {
  IAgentToolService,
  type AgentToolDidRunSubagentContext,
  type AgentToolWillRunSubagentContext,
} from './agentToolServiceToken';

export class AgentToolService extends Disposable implements IAgentToolService {
  declare readonly _serviceBrand: undefined;
  readonly hooks: IAgentToolService['hooks'] = {
    onWillRunSubagent: new OrderedHookSlot<AgentToolWillRunSubagentContext>(),
    onDidRunSubagent: new OrderedHookSlot<AgentToolDidRunSubagentContext>(),
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolService,
  AgentToolService,
  InstantiationType.Eager,
  'agentTool',
);
