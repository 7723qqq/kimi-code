/**
 * `fileTools` domain (L4) — built-in file tool registration contract.
 *
 * `IAgentFileToolsService` is a marker: its implementation registers the built-in
 * file tools (Read / Write / Edit / Grep / Glob) into the agent `IAgentToolRegistryService`
 * on construction. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentFileToolsService {
  readonly _serviceBrand: undefined;
}

export const IAgentFileToolsService: ServiceIdentifier<IAgentFileToolsService> =
  createDecorator<IAgentFileToolsService>('agentFileToolsService');
