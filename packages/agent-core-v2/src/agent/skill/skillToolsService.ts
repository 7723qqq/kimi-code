/**
 * `skillTools` domain (L4) — `IAgentSkillToolsService` implementation.
 *
 * Eager Agent-scope registration service for the built-in `Skill` collaboration
 * tool. The tool is a DI class created via `IInstantiationService.createInstance`
 * (it injects `ISessionSkillCatalog`, `IAgentPromptService` and
 * `IAgentSkillService` itself) and registered into the agent
 * `IAgentToolRegistryService`. Eager so the tool is registered when the Agent
 * scope is created, before the first turn.
 *
 * Split out of `AgentSkillService` so the tool can inject `IAgentSkillService`
 * without forming a constructor-instantiation cycle, and so the previous
 * `recordActivation` closure can be replaced by a direct service call.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { IAgentSkillToolsService } from './skillTools';
import { SkillTool } from '#/agent/skill/tools/skill';

export class AgentSkillToolsService extends Disposable implements IAgentSkillToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super();
    this._register(toolRegistry.register(instantiationService.createInstance(SkillTool)));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillToolsService,
  AgentSkillToolsService,
  InstantiationType.Eager,
  'skill',
);
