/**
 * `goalTools` domain (L4) — `IAgentGoalToolsService` implementation.
 *
 * Eager Agent-scope registration service for the built-in goal tools
 * (CreateGoal / GetGoal / SetGoalBudget / UpdateGoal). Each tool is a DI class
 * created via `IInstantiationService.createInstance` (they inject
 * `IAgentGoalService`, and `CreateGoal` also injects
 * `IAgentPermissionModeService`, themselves) and registered into the agent
 * `IAgentToolRegistryService`. Eager so the tools are registered when the Agent
 * scope is created, before the first turn.
 *
 * Split out of `AgentGoalService` so the tools can inject `IAgentGoalService`
 * without forming a constructor-instantiation cycle.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { IAgentGoalToolsService } from './goalTools';
import { CreateGoalTool } from '#/agent/goal/tools/create-goal';
import { GetGoalTool } from '#/agent/goal/tools/get-goal';
import { SetGoalBudgetTool } from '#/agent/goal/tools/set-goal-budget';
import { UpdateGoalTool } from '#/agent/goal/tools/update-goal';

export class AgentGoalToolsService extends Disposable implements IAgentGoalToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super();
    this._register(toolRegistry.register(instantiationService.createInstance(CreateGoalTool)));
    this._register(toolRegistry.register(instantiationService.createInstance(GetGoalTool)));
    this._register(toolRegistry.register(instantiationService.createInstance(SetGoalBudgetTool)));
    this._register(toolRegistry.register(instantiationService.createInstance(UpdateGoalTool)));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentGoalToolsService,
  AgentGoalToolsService,
  InstantiationType.Eager,
  'goal',
);
