/**
 * `swarmTools` domain (L4) — `IAgentSwarmToolsService` implementation.
 *
 * Eager Agent-scope registration service for the built-in `AgentSwarm`
 * collaboration tool. The tool is a DI class created via
 * `IInstantiationService.createInstance` (it injects `ISessionSwarmService` for
 * batch runs, `IAgentScopeContext` for the caller identity, and
 * `IAgentSwarmService` to enter swarm mode) and registered into the agent
 * `IAgentToolRegistryService`. Eager so the tool is registered when the Agent
 * scope is created, before the first turn.
 *
 * Split out of `AgentSwarmService` so the tool can inject `IAgentSwarmService`
 * without forming a constructor-instantiation cycle.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { IAgentSwarmToolsService } from './swarmTools';
import { AgentSwarmTool } from '#/agent/swarm/tools/agent-swarm';

export class AgentSwarmToolsService extends Disposable implements IAgentSwarmToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super();
    this._register(toolRegistry.register(instantiationService.createInstance(AgentSwarmTool)));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSwarmToolsService,
  AgentSwarmToolsService,
  InstantiationType.Eager,
  'swarm',
);
