import {
  AgentDateChangeService,
  IAgentDateChangeService,
} from '#/features/dateChange/dateChangeService';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

export class DateChangeFeature extends Feature {
  static override readonly name = 'dateChange';

  constructor() {
    super();
    this.contributeAgentService(IAgentDateChangeService, AgentDateChangeService);
  }
}

registerFeature(DateChangeFeature);
