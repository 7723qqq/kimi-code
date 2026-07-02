/**
 * `skillTools` domain (L4) — `IAgentSkillToolsService` registration contract.
 *
 * Marker service: its implementation registers the built-in `Skill` collaboration
 * tool into the agent `IAgentToolRegistryService` on construction. Bound at Agent
 * scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentSkillToolsService {
  readonly _serviceBrand: undefined;
}

export const IAgentSkillToolsService: ServiceIdentifier<IAgentSkillToolsService> =
  createDecorator<IAgentSkillToolsService>('agentSkillToolsService');
