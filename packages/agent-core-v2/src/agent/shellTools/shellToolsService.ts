/**
 * `shellTools` domain (L4) — `IAgentShellToolsService` implementation.
 *
 * Registers the built-in Bash tool into the agent `IAgentToolRegistryService` on
 * construction, wiring it to the session `ISessionProcessRunner` (process spawn),
 * `IKaos` (cwd + OS/shell probe) and `IAgentBackgroundService` (background-task
 * lifecycle). Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentBackgroundService } from '#/agent/background';
import { IKaos } from '#/app/kaos';
import { ISessionProcessRunner } from '#/session/process';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { IAgentShellToolsService } from './shellTools';
import { BashTool } from '#/agent/shellTools/tools/bash';

export class AgentShellToolsService implements IAgentShellToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
    @ISessionProcessRunner runner: ISessionProcessRunner,
    @IKaos kaos: IKaos,
    @IAgentBackgroundService background: IAgentBackgroundService,
    @IAgentProfileService profile: IAgentProfileService,
  ) {
    toolRegistry.register(new BashTool(runner, kaos, background, {
      allowBackground: () =>
        profile.isToolActive('TaskOutput') && profile.isToolActive('TaskStop'),
    }));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentShellToolsService,
  AgentShellToolsService,
  InstantiationType.Delayed,
  'shellTools',
);
