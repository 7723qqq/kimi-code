import { createDecorator } from '../../../di';
import type { IDisposable } from '../../../di';

export interface DynamicInjectionState {
  readonly injectedAt: number | null;
}

export type DynamicInjectionProvider = (
  state: DynamicInjectionState,
) => string | undefined | Promise<string | undefined>;

export interface IDynamicInjector {
  register(injector: DynamicInjectionProvider): IDisposable;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IDynamicInjector = createDecorator<IDynamicInjector>(
  'agentDynamicInjectorService',
);
