/**
 * `planTools` domain (L4) — `IAgentPlanToolsService` registration contract.
 *
 * Marker service: its implementation registers the built-in plan-mode tools
 * (EnterPlanMode / ExitPlanMode) into the agent `IAgentToolRegistryService` on
 * construction. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentPlanToolsService {
  readonly _serviceBrand: undefined;
}

export const IAgentPlanToolsService: ServiceIdentifier<IAgentPlanToolsService> =
  createDecorator<IAgentPlanToolsService>('agentPlanToolsService');
