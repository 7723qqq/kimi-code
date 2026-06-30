import { createDecorator } from "#/_base/di";
import type { IDisposable } from "#/_base/di";

export interface ContextInjectionContext {
  readonly lastInjectedAt: number | null;
}

export interface ContextInjectionOptions {
  readonly cadence?: 'step' | 'turn';
}

export type ContextInjectionProvider = (
  context: ContextInjectionContext,
) => string | undefined | Promise<string | undefined>;

export interface IAgentContextInjectorService {
  readonly _serviceBrand: undefined;
  register(
    variant: string,
    provider: ContextInjectionProvider,
    options?: ContextInjectionOptions,
  ): IDisposable;
}

export const IAgentContextInjectorService = createDecorator<IAgentContextInjectorService>(
  'agentContextInjectorService',
);
