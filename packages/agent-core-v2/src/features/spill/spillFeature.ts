/**
 * `spill` domain — `SpillFeature`: the spill-storage capability assembled as
 * one App-scope Feature unit.
 *
 * Contributes the `[spill]` config section and the per-Session `ISpillService`
 * through the `features` base-class seams; retracting the unit withdraws both
 * across the scope tree. Registered into the feature table at import.
 */

import { z } from 'zod';

import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { ISpillService } from './spill';
import { SpillService } from './spillService';

const SPILL_SECTION = 'spill';

const SpillConfigSchema = z.object({
  root: z.string().optional(),
});

export class SpillFeature extends Feature {
  static override readonly name = 'spill';

  constructor() {
    super();
    this.contributeConfig(SPILL_SECTION, SpillConfigSchema, {
      defaultValue: { root: undefined },
    });
    this.contributeService(LifecycleScope.Session, ISpillService, SpillService);
  }
}

registerFeature(SpillFeature);
