/**
 * `backgroundTools` domain (L4) — `IAgentBackgroundToolsService` implementation.
 *
 * Eager Agent-scope registration service for the built-in background-task tools
 * (TaskList / TaskOutput / TaskStop). Each tool is a DI class created via
 * `IInstantiationService.createInstance` (they inject `IAgentBackgroundService`
 * themselves) and registered into the agent `IAgentToolRegistryService`. Eager so
 * the tools are registered when the Agent scope is created, before the first turn.
 *
 * Split out of `AgentBackgroundService` so the tools can inject
 * `IAgentBackgroundService` without forming a constructor-instantiation cycle.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { IAgentBackgroundToolsService } from './backgroundTools';
import { TaskListTool } from '#/agent/background/tools/task-list';
import { TaskOutputTool } from '#/agent/background/tools/task-output';
import { TaskStopTool } from '#/agent/background/tools/task-stop';

export class AgentBackgroundToolsService extends Disposable implements IAgentBackgroundToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super();
    this._register(toolRegistry.register(instantiationService.createInstance(TaskListTool)));
    this._register(toolRegistry.register(instantiationService.createInstance(TaskOutputTool)));
    this._register(toolRegistry.register(instantiationService.createInstance(TaskStopTool)));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentBackgroundToolsService,
  AgentBackgroundToolsService,
  InstantiationType.Eager,
  'background',
);
