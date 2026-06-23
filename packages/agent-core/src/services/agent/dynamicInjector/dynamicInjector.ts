import { createDecorator } from '../../../di';
import type { IDisposable } from '../../../di';

export interface DynamicInjectionContext {
  readonly injectedAt: number | null;
}

export type DynamicInjectionProvider = (
  context: DynamicInjectionContext,
) => string | undefined | Promise<string | undefined>;

export interface IDynamicInjector {
  register(
    variant: string,
    provider: DynamicInjectionProvider,
  ): IDisposable;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IDynamicInjector = createDecorator<IDynamicInjector>(
  'agentDynamicInjectorService',
);
