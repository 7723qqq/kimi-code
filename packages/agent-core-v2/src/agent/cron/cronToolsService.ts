/**
 * `cronTools` domain (L4) — `IAgentCronToolsService` implementation.
 *
 * Eager Agent-scope registration service for the built-in cron tools
 * (CronCreate / CronList / CronDelete). Each tool is a DI class created via
 * `IInstantiationService.createInstance` (they inject `IAgentCronService`
 * themselves) and registered into the agent `IAgentToolRegistryService`.
 *
 * Registration is gated on `IAgentCronService.isEnabled` (cron only runs on the
 * main agent), matching the previous in-service behavior. The global
 * `cron.disabled` killswitch (`KIMI_DISABLE_CRON`) is read from config and passed
 * to `CronCreateTool` as a leading static argument so the tool can surface a
 * friendly error when scheduling is disabled.
 *
 * Split out of `AgentCronService` so the tools can inject `IAgentCronService`
 * without forming a constructor-instantiation cycle. Eager so the tools are
 * registered when the Agent scope is created, before the first turn.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config';
import { IAgentCronService } from '#/agent/cron';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { type CronConfig, CRON_SECTION, DEFAULT_CRON_CONFIG } from './configSection';
import { IAgentCronToolsService } from './cronTools';
import { CronCreateTool } from '#/agent/cron/tools/cron-create';
import { CronDeleteTool } from '#/agent/cron/tools/cron-delete';
import { CronListTool } from '#/agent/cron/tools/cron-list';

export class AgentCronToolsService extends Disposable implements IAgentCronToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
    @IAgentCronService cron: IAgentCronService,
    @IConfigService config: IConfigService,
  ) {
    super();
    if (!cron.isEnabled) return;
    const disabled =
      config.get<CronConfig>(CRON_SECTION)?.disabled ?? DEFAULT_CRON_CONFIG.disabled;
    this._register(
      toolRegistry.register(instantiationService.createInstance(CronCreateTool, disabled)),
    );
    this._register(toolRegistry.register(instantiationService.createInstance(CronListTool)));
    this._register(toolRegistry.register(instantiationService.createInstance(CronDeleteTool)));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentCronToolsService,
  AgentCronToolsService,
  InstantiationType.Eager,
  'cron',
);
