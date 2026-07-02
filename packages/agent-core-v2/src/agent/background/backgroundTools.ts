/**
 * `backgroundTools` domain (L4) — `IAgentBackgroundToolsService` registration contract.
 *
 * Marker service: its implementation registers the built-in background-task tools
 * (TaskList / TaskOutput / TaskStop) into the agent `IAgentToolRegistryService` on
 * construction. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentBackgroundToolsService {
  readonly _serviceBrand: undefined;
}

export const IAgentBackgroundToolsService: ServiceIdentifier<IAgentBackgroundToolsService> =
  createDecorator<IAgentBackgroundToolsService>('agentBackgroundToolsService');
