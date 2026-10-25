import { ScopeActivation } from '#/_base/di/instantiation';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IAgentHelloWorldService } from './agent/helloWorld';
import { AgentHelloWorldService } from './agent/helloWorldService';

export class HelloWorldFeature extends Feature {
  static override readonly name = 'helloWorld';

  constructor() {
    super();
    this.contributeAgentService(IAgentHelloWorldService, AgentHelloWorldService, {
      activation: ScopeActivation.OnScopeCreated,
    });
  }
}

registerFeature(HelloWorldFeature);
