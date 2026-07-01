/**
 * `shellTools` domain (L4) — built-in shell tool registration contract.
 *
 * `IAgentShellToolsService` is a marker: its implementation registers the built-in
 * Bash tool into the agent `IAgentToolRegistryService` on construction. Bound at Agent
 * scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentShellToolsService {
  readonly _serviceBrand: undefined;
}

export const IAgentShellToolsService: ServiceIdentifier<IAgentShellToolsService> =
  createDecorator<IAgentShellToolsService>('agentShellToolsService');
