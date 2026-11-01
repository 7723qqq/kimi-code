import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { EnvironmentProviderFactory } from '#/environment/environmentProvider';
import type { EnvironmentRegistry } from '#/environment/environmentRegistry';

export interface EnvironmentResolver extends Pick<
  EnvironmentRegistry,
  'inspect' | 'acquire' | 'acquireWhenReady'
> {
  readonly _serviceBrand: undefined;
}

export interface IEnvironmentService
  extends
    EnvironmentResolver,
    Pick<
      EnvironmentRegistry,
      'onDidChange' | 'snapshot' | 'current' | 'register' | 'drainSession'
    > {
  readonly ready: Promise<void>;
  addProvider(factory: EnvironmentProviderFactory): Promise<{ dispose(): Promise<void> }>;
}

export const IEnvironmentService: ServiceIdentifier<IEnvironmentService> =
  createDecorator<IEnvironmentService>('environmentService');
