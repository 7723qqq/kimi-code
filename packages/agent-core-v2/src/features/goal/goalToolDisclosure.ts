import { type ServicesAccessor } from '#/_base/di/instantiation';
import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ToolDisclosureContribution } from '#/agent/toolDisclosure/toolDisclosure';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { AgentGoal } from './goalAgentRuntime';

export interface IGoalToolDisclosureSource {
  readonly _serviceBrand: undefined;
}

export const IGoalToolDisclosureSource = createDecorator<IGoalToolDisclosureSource>(
  'goalToolDisclosureSource',
);

export function goalControlToolsVisible(accessor: ServicesAccessor): boolean {
  const scope = accessor.get(IAgentScopeContext);
  const lifecycle = accessor.get(IAgentLifecycleService);
  return lifecycle.resolve(scope.agentContext, AgentGoal).getGoal().goal !== null;
}

export class GoalToolDisclosureSource extends Service implements IGoalToolDisclosureSource {
  declare readonly _serviceBrand: undefined;

  constructor() {
    super();
    this.provide(ToolDisclosureContribution, {
      name: 'UpdateGoal',
      visible: goalControlToolsVisible,
    });
    this.provide(ToolDisclosureContribution, {
      name: 'SetGoalBudget',
      visible: goalControlToolsVisible,
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  IGoalToolDisclosureSource,
  GoalToolDisclosureSource,
  ScopeActivation.OnScopeCreated,
  'goalDisclosure',
);