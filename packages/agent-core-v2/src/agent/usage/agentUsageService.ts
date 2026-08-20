import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { agentSpaceOf } from '#/agent/agentContext/agentSpace';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { LifecycleScope } from '#/app/scopes';
import { UsageAgentModelDefinition } from '#/session/usage/usageAgentModel';

import {
  IAgentUsageService,
  type UsageRecordedContext,
  type UsageStatus,
} from './usage';

/**
 * Agent-scoped usage facade over the per-agent `UsageAgentModel`. Session
 * consumers (`persistentSubagentService`, tests) read per-agent status
 * through this token; recording flows through the session service.
 */
export class AgentUsageService extends Disposable implements IAgentUsageService {
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentScopeContext private readonly scopeContext: IAgentScopeContext) {
    super();
  }

  status(): UsageStatus {
    return agentSpaceOf(this.scopeContext.agentContext).use(UsageAgentModelDefinition, (model) =>
      model.status(),
    );
  }

  record(ctx: UsageRecordedContext): void {
    void agentSpaceOf(ctx.agent).use(UsageAgentModelDefinition, (model) =>
      model.record({ model: ctx.model, usage: ctx.usage, source: ctx.source }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentUsageService,
  AgentUsageService,
  ScopeActivation.OnScopeCreated,
  'usage',
);