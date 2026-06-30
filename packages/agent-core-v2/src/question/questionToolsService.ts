/**
 * `question` domain (L7) — `IAgentQuestionToolsService` implementation.
 *
 * Registers the built-in `AskUserQuestion` tool into the agent `IAgentToolRegistryService`
 * on construction, wiring it to the session `ISessionQuestionService` (ask-user
 * broker), the agent `IAgentBackgroundService` (background-question lifecycle) and
 * `ITelemetryService`. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentBackgroundService } from '#/background';
import { ITelemetryService } from '#/telemetry';
import { IAgentToolRegistryService } from '#/toolRegistry';

import { ISessionQuestionService } from './question';
import { IAgentQuestionToolsService } from './questionTools';
import { AskUserQuestionTool } from './tools/ask-user';

export class AgentQuestionToolsService implements IAgentQuestionToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
    @ISessionQuestionService question: ISessionQuestionService,
    @IAgentBackgroundService background: IAgentBackgroundService,
    @ITelemetryService telemetry: ITelemetryService,
  ) {
    toolRegistry.register(new AskUserQuestionTool(question, background, telemetry));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentQuestionToolsService,
  AgentQuestionToolsService,
  InstantiationType.Delayed,
  'questionTools',
);
