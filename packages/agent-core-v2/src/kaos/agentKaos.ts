/**
 * `kaos` domain (L1) — `IKaosService` implementation.
 *
 * Exposes the agent's active `Kaos` instance. Bound at Agent scope.
 */

import type { Kaos } from '@moonshot-ai/kaos';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IKaosService, ISessionKaosService } from './kaos';

export class AgentKaos implements IKaosService {
  declare readonly _serviceBrand: undefined;
  private _kaos: Kaos;

  constructor(@ISessionKaosService sessionKaos: ISessionKaosService) {
    this._kaos = sessionKaos.toolKaos;
  }

  get kaos(): Kaos {
    return this._kaos;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IKaosService,
  AgentKaos,
  InstantiationType.Delayed,
  'kaos',
);
