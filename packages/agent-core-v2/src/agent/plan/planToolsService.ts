/**
 * `planTools` domain (L4) — `IAgentPlanToolsService` implementation.
 *
 * Eager Agent-scope registration service for the built-in plan-mode tools
 * (EnterPlanMode / ExitPlanMode). Each tool is a DI class created via
 * `IInstantiationService.createInstance` (they inject `IAgentPlanService` and
 * `ITelemetryService` themselves) and registered into the agent
 * `IAgentToolRegistryService`. Eager so the tools are registered when the Agent
 * scope is created, before the first turn.
 *
 * Split out of `AgentPlanService` so the tools can inject `IAgentPlanService`
 * without forming a constructor-instantiation cycle; this also replaces the
 * previous inline object-literal registrations with real DI tool classes.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { IAgentPlanToolsService } from './planTools';
import { EnterPlanModeTool } from '#/agent/plan/tools/enter-plan-mode';
import { ExitPlanModeTool } from '#/agent/plan/tools/exit-plan-mode';

export class AgentPlanToolsService extends Disposable implements IAgentPlanToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super();
    this._register(toolRegistry.register(instantiationService.createInstance(EnterPlanModeTool)));
    this._register(toolRegistry.register(instantiationService.createInstance(ExitPlanModeTool)));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPlanToolsService,
  AgentPlanToolsService,
  InstantiationType.Eager,
  'plan',
);
