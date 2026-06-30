/**
 * `kaos` domain (L1) — `IKaosFactory` implementation.
 *
 * Builds an `IKaos` for a session. Today only local (`LocalKaos`); ssh/container
 * are added behind the same factory later. Bound at Core scope.
 */

import { LocalKaos } from '@moonshot-ai/kaos';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { type IKaos, IKaosFactory } from './kaos';
import { KaosService } from './kaosService';

export class KaosFactory implements IKaosFactory {
  declare readonly _serviceBrand: undefined;

  async createLocal(cwd: string): Promise<IKaos> {
    const base = await LocalKaos.create();
    return new KaosService(base.withCwd(cwd));
  }
}

registerScopedService(
  LifecycleScope.Core,
  IKaosFactory,
  KaosFactory,
  InstantiationType.Delayed,
  'kaos',
);
