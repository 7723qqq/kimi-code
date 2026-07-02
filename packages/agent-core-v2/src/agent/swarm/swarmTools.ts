/**
 * `swarmTools` domain (L4) — `IAgentSwarmToolsService` registration contract.
 *
 * Marker service: its implementation registers the built-in `AgentSwarm`
 * collaboration tool into the agent `IAgentToolRegistryService` on construction.
 * Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentSwarmToolsService {
  readonly _serviceBrand: undefined;
}

export const IAgentSwarmToolsService: ServiceIdentifier<IAgentSwarmToolsService> =
  createDecorator<IAgentSwarmToolsService>('agentSwarmToolsService');
