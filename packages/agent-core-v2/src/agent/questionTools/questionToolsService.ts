/**
 * `questionTools` domain (L7) — `IAgentQuestionToolsService` implementation.
 *
 * Eager Agent-scope registration service for the built-in `AskUserQuestion` tool.
 * The tool is a DI class created via `IInstantiationService.createInstance` and
 * registered into the agent `IAgentToolRegistryService`. Eager so the tool is
 * registered when the Agent scope is created, before the first turn.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { IAgentQuestionToolsService } from './questionTools';
import { AskUserQuestionTool } from '#/agent/questionTools/tools/ask-user';

export class AgentQuestionToolsService extends Disposable implements IAgentQuestionToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super();
    this._register(
      toolRegistry.register(instantiationService.createInstance(AskUserQuestionTool)),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentQuestionToolsService,
  AgentQuestionToolsService,
  InstantiationType.Eager,
  'questionTools',
);
