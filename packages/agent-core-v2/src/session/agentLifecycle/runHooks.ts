/**
 * `agentLifecycle` domain (L6) — hook-slot host for the requester-side agent
 * run wrapper (`mirrorAgentRun`).
 *
 * When one agent drives another (the `Agent` tool, the swarm scheduler),
 * `mirrorAgentRun` announces "an agent run I am hosting is about to start" and
 * "...has stopped" through these ordered slots. Observers — most notably the
 * Agent-scope `externalHooks` adapter, which translates them into the
 * `SubagentStart` / `SubagentStop` external hook commands — register here
 * instead of `mirrorAgentRun` calling them directly. Bound at Agent scope so
 * each requester agent gets its own slot (and only its own observers see its
 * launches), matching the other Agent-scope hook hosts (`toolExecutor`,
 * `prompt`, ...).
 *
 * The slots carry the raw run facts (`prompt` / `response`); observers apply
 * their own truncation. `onWillStartAgentTask` is awaited by `mirrorAgentRun`
 * before the run proceeds, preserving start-before-stop ordering;
 * `onDidStopAgentTask` is driven fire-and-forget.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { createHooks, type Hooks } from '#/hooks';

/** Facts announced when an agent run this agent is hosting is about to start. */
export interface AgentTaskStartHookContext {
  readonly agentName: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

/** Facts announced when an agent run this agent is hosting has stopped. */
export interface AgentTaskStopHookContext {
  readonly agentName: string;
  readonly response: string;
}

export type AgentTaskHooks = {
  readonly onWillStartAgentTask: AgentTaskStartHookContext;
  readonly onDidStopAgentTask: AgentTaskStopHookContext;
};

export interface IAgentRunHooksService {
  readonly _serviceBrand: undefined;
  readonly hooks: Hooks<AgentTaskHooks>;
}

export const IAgentRunHooksService: ServiceIdentifier<IAgentRunHooksService> =
  createDecorator<IAgentRunHooksService>('agentRunHooksService');

export class AgentRunHooksService implements IAgentRunHooksService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>([
    'onWillStartAgentTask',
    'onDidStopAgentTask',
  ]);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRunHooksService,
  AgentRunHooksService,
  InstantiationType.Delayed,
  'agentLifecycle',
);
