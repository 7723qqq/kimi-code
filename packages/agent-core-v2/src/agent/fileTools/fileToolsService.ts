/**
 * `fileTools` domain (L4) — `IAgentFileToolsService` implementation.
 *
 * Eager Agent-scope registration service for the built-in file tools
 * (Read / Write / Edit / Grep / Glob). Each tool is a DI class created via
 * `IInstantiationService.createInstance` (so its session/app dependencies are
 * injected) and registered into the agent `IAgentToolRegistryService`. Eager so
 * the tools are registered when the Agent scope is created, before the first turn.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { IAgentFileToolsService } from './fileTools';
import { EditTool } from '#/agent/fileTools/tools/edit';
import { GlobTool } from '#/agent/fileTools/tools/glob';
import { GrepTool } from '#/agent/fileTools/tools/grep';
import { ReadTool } from '#/agent/fileTools/tools/read';
import { WriteTool } from '#/agent/fileTools/tools/write';

export class AgentFileToolsService extends Disposable implements IAgentFileToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super();
    this._register(toolRegistry.register(instantiationService.createInstance(ReadTool)));
    this._register(toolRegistry.register(instantiationService.createInstance(WriteTool)));
    this._register(toolRegistry.register(instantiationService.createInstance(EditTool)));
    this._register(toolRegistry.register(instantiationService.createInstance(GrepTool)));
    this._register(toolRegistry.register(instantiationService.createInstance(GlobTool)));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentFileToolsService,
  AgentFileToolsService,
  InstantiationType.Eager,
  'fileTools',
);
