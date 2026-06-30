/**
 * `question` domain (L7) — ask-user tool registration contract.
 *
 * `IAgentQuestionToolsService` is a marker: its implementation registers the
 * built-in `AskUserQuestion` tool into the agent `IAgentToolRegistryService` on
 * construction. Bound at Agent scope (the tool needs the agent-scoped
 * `IAgentToolRegistryService` and `IAgentBackgroundService`, plus the session-scoped
 * `ISessionQuestionService`).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentQuestionToolsService {
  readonly _serviceBrand: undefined;
}

export const IAgentQuestionToolsService: ServiceIdentifier<IAgentQuestionToolsService> =
  createDecorator<IAgentQuestionToolsService>('agentQuestionToolsService');
