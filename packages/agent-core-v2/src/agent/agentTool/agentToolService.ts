/**
 * `agentTool` domain (L5) — registers the `Agent` collaboration tool for an agent.
 *
 * Eager Agent-scope registration service for the `Agent` tool, which lets the
 * agent spawn task subagents. The tool is a DI class created via
 * `IInstantiationService.createInstance` (its dependencies — identity via
 * `scopeContext`, child creation via `agentLifecycle`, parent check via
 * `sessionMetadata`, background gating via `profile`, git context via
 * `execContext` + `process` — are injected) and registered into the agent
 * `IAgentToolRegistryService`. The optional leading static `runner` argument is a
 * test seam (`AgentToolRunOverride`) that lets tests substitute the
 * `runChildAgent` helpers; the scoped registry supplies none. Eager so the tool
 * is registered when the Agent scope is created, before the first turn.
 */

import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { AgentTool } from './agentTool';
import { IAgentToolService } from './agentToolServiceToken';
import type { AgentToolRunOverride } from './runChildAgent';

export class AgentToolService extends Disposable implements IAgentToolService {
  declare readonly _serviceBrand: undefined;

  constructor(
    runner: AgentToolRunOverride | undefined,
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super();
    this._register(
      toolRegistry.register(instantiationService.createInstance(AgentTool, runner)),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolService,
  AgentToolService,
  InstantiationType.Eager,
  'agentTool',
);
