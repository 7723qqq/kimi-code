import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type ExclusiveReviewMode = 'plan' | 'spec' | 'swarm' | 'tower';

export interface IAgentModeMutexService {
  readonly _serviceBrand: undefined;

  activeMode(): ExclusiveReviewMode | null;

  switchTo(target: ExclusiveReviewMode): Promise<void>;

  leave(target: ExclusiveReviewMode): Promise<void>;
}

export const IAgentModeMutexService: ServiceIdentifier<IAgentModeMutexService> =
  createDecorator<IAgentModeMutexService>('agentModeMutexService');
