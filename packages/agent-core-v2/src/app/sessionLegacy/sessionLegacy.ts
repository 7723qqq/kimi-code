import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { GoalSnapshot } from '#/features/goal/types';

export interface ISessionLegacyService {
  readonly _serviceBrand: undefined;

  goal(sessionId: string): Promise<GoalSnapshot | null>;
}

export const ISessionLegacyService: ServiceIdentifier<ISessionLegacyService> =
  createDecorator<ISessionLegacyService>('sessionLegacyService');
