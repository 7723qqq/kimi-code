import type { Kaos } from '@moonshot-ai/kaos';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IKaosService } from './kaos';

export interface KaosServiceOptions {
  readonly kaos?: Kaos;
}

export class KaosService implements IKaosService {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly options: KaosServiceOptions = {}) {}

  get kaos(): Kaos | undefined {
    return this.options.kaos;
  }

  get cwd(): string {
    const kaos = this.options.kaos;
    if (kaos === undefined) {
      throw new Error('KaosService.cwd accessed before kaos was provided');
    }
    return kaos.getcwd();
  }

  chdir(): Promise<void> {
    return Promise.reject(new Error('KaosService.chdir is not supported'));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IKaosService,
  KaosService,
  InstantiationType.Delayed,
  'kaos',
);
