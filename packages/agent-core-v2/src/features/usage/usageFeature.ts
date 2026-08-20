import { LifecycleScope } from '#/app/scopes';
import { AgentUsageService } from '#/agent/usage/agentUsageService';
import { IAgentUsageService } from '#/agent/usage/usage';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { SessionUsageService } from '#/session/usage/sessionUsageService';
import { UsageAgentModelDefinition } from '#/session/usage/usageAgentModel';

export class UsageFeature extends Feature {
  static override readonly name = 'usage';

  constructor() {
    super();
    this.contributeAgentModel(UsageAgentModelDefinition);
    this.contributeService(LifecycleScope.Session, ISessionUsageService, SessionUsageService);
    this.contributeService(LifecycleScope.Agent, IAgentUsageService, AgentUsageService);
  }
}

registerFeature(UsageFeature);
