/**
 * `fileTools` domain (L4) — `IFileToolsService` implementation.
 *
 * Registers the built-in file tools (Read / Write / Edit / Grep / Glob) into
 * the agent `IToolRegistry` on construction, wiring each to the session
 * `IAgentFileSystem` (file IO), `IFsService` (workspace search/grep), `IKaos`
 * (path semantics) and the session workspace. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { WorkspaceConfig } from '#/_base/tools/support/workspace';
import { IAgentFileSystem, IFsService } from '#/agentFs';
import { IKaos } from '#/kaos';
import { IToolRegistry } from '#/toolRegistry';
import { IWorkspaceContext } from '#/workspaceContext';

import { IFileToolsService } from './fileTools';
import { EditTool } from './tools/edit';
import { GlobTool } from './tools/glob';
import { GrepTool } from './tools/grep';
import { ReadTool } from './tools/read';
import { WriteTool } from './tools/write';

export class FileToolsService implements IFileToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IToolRegistry toolRegistry: IToolRegistry,
    @IAgentFileSystem fs: IAgentFileSystem,
    @IKaos kaos: IKaos,
    @IWorkspaceContext workspace: IWorkspaceContext,
    @IFsService fsService: IFsService,
  ) {
    const workspaceConfig: WorkspaceConfig = {
      workspaceDir: workspace.workDir,
      additionalDirs: workspace.additionalDirs,
    };
    toolRegistry.register(new ReadTool(fs, kaos, workspaceConfig));
    toolRegistry.register(new WriteTool(fs, kaos, workspaceConfig));
    toolRegistry.register(new EditTool(fs, kaos, workspaceConfig));
    toolRegistry.register(new GrepTool(fsService, kaos, workspaceConfig));
    toolRegistry.register(new GlobTool(fs, kaos, workspaceConfig));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IFileToolsService,
  FileToolsService,
  InstantiationType.Delayed,
  'fileTools',
);
