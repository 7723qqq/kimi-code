/**
 * `shellTools` domain (L4) — `IAgentShellToolsService` implementation.
 *
 * Eager Agent-scope registration service for the built-in Bash tool. The tool is
 * a DI class created via `IInstantiationService.createInstance` and registered
 * into the agent `IAgentToolRegistryService`. Eager so Bash is registered when
 * the Agent scope is created, before the first turn.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { IAgentShellToolsService } from './shellTools';
import { BashTool } from '#/agent/shellTools/tools/bash';

export class AgentShellToolsService extends Disposable implements IAgentShellToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super();
    this._register(toolRegistry.register(instantiationService.createInstance(BashTool)));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentShellToolsService,
  AgentShellToolsService,
  InstantiationType.Eager,
  'shellTools',
);
