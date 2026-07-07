/**
 * `externalHooks` domain (L6) — Session-scope external hook observer contract.
 *
 * Exposes an empty Session-scope service whose implementation registers
 * session lifecycle callbacks from its constructor. The lifecycle owner invokes
 * its own hook slots; callers never trigger session external hooks through
 * this contract.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionExternalHooksService {
  readonly _serviceBrand: undefined;
}

export const ISessionExternalHooksService: ServiceIdentifier<ISessionExternalHooksService> =
  createDecorator<ISessionExternalHooksService>('sessionExternalHooksService');
