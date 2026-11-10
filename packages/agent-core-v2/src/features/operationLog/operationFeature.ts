import { ScopeActivation } from '#/_base/di/instantiation';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IAgentOperationService, AgentOperationService } from './operationService';

export class OperationFeature extends Feature {
  static override readonly name = 'operationLog';

  constructor() {
    super();
    this.contributeAgentService(IAgentOperationService, AgentOperationService, {
      activation: ScopeActivation.OnScopeCreated,
    });
  }
}

registerFeature(OperationFeature);
