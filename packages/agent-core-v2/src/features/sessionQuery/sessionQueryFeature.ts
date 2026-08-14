/**
 * `sessionQuery` domain — `SessionQueryFeature`: the logical-corpus query
 * capability assembled as one App-scope Feature unit.
 *
 * Contributes the App-scope `ISessionQueryService` through the `features`
 * base-class seams; retracting the unit withdraws it. Registered into the
 * feature table at import.
 */

import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { ISessionQueryService, SessionQueryService } from './sessionQueryService';

export class SessionQueryFeature extends Feature {
  static override readonly name = 'sessionQuery';

  constructor() {
    super();
    this.contributeService(LifecycleScope.App, ISessionQueryService, SessionQueryService);
  }
}

registerFeature(SessionQueryFeature);
