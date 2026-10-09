import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { DeepseekAdaptationService, IDeepseekAdaptationService } from './deepseekAdaptationService';

export class DeepseekAdaptationFeature extends Feature {
  static override readonly name = 'deepseekAdaptation';

  constructor() {
    super();
    this.contributeAgentService(IDeepseekAdaptationService, DeepseekAdaptationService);
  }
}

registerFeature(DeepseekAdaptationFeature);
