/**
 * `goalTools` domain (L4) — `IAgentGoalToolsService` registration contract.
 *
 * Marker service: its implementation registers the built-in goal tools
 * (CreateGoal / GetGoal / SetGoalBudget / UpdateGoal) into the agent
 * `IAgentToolRegistryService` on construction. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentGoalToolsService {
  readonly _serviceBrand: undefined;
}

export const IAgentGoalToolsService: ServiceIdentifier<IAgentGoalToolsService> =
  createDecorator<IAgentGoalToolsService>('agentGoalToolsService');
