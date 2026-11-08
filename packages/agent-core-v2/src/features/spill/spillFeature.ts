import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './configSection';
import { ISpillService } from './spill';
import { SpillService } from './spillService';

export class SpillFeature extends Feature {
  static override readonly name = 'spill';

  constructor() {
    super();
    this.contributeService(LifecycleScope.Session, ISpillService, SpillService);
  }
}

registerFeature(SpillFeature);
