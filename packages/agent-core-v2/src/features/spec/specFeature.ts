import { IFlagService } from '#/app/flag/flag';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './flag';
import { SPEC_MODE_FLAG_ID, IAgentSpecService } from './spec';
import { AgentSpecService } from './specService';

export class SpecFeature extends Feature {
  static override readonly name = 'spec';

  constructor(@IFlagService flags: IFlagService) {
    super();
    if (!flags.enabled(SPEC_MODE_FLAG_ID)) return;
    this.contributeAgentService(IAgentSpecService, AgentSpecService);
  }
}

registerFeature(SpecFeature);
